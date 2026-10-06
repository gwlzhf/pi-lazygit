import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DIFF_CONTEXT, FULL_DIFF_CONTEXT, MAX_PREVIEW_BYTES } from "../contracts";
import { GitRepository } from "./repository";
import {
  BunProcessRunner,
  type CommandOutput,
  type ProcessRunner,
  type RunOptions,
} from "./process";

const temporaryDirectories: string[] = [];

const encoder = new TextEncoder();
interface GitHistoryEntry {
  readonly oid: string;
  readonly shortOid: string;
  readonly subject: string;
  readonly author: string;
  readonly authoredAt: number;
}

interface GitHistoryRepository {
  history(signal: AbortSignal): Promise<{
    readonly entries: readonly GitHistoryEntry[];
    readonly truncated: boolean;
  }>;
  commitDiff(
    oid: string,
    signal: AbortSignal,
    contextLines?: number,
  ): Promise<{
    readonly oid: string;
    readonly kind: "diff" | "error";
    readonly lines: readonly string[];
    readonly truncated: boolean;
  }>;
}


function commandOutput(
  stdout = "",
  stderr = "",
  exitCode = 0,
): CommandOutput {
  return {
    stdout: encoder.encode(stdout),
    stderr,
    exitCode,
    truncated: false,
  };
}

class ScriptedRunner implements ProcessRunner {
  readonly calls: Array<{
    readonly executable: string;
    readonly args: readonly string[];
    readonly options?: RunOptions;
  }> = [];

  constructor(
    private readonly response: (args: readonly string[]) => CommandOutput,
  ) {}

  async run(
    _cwd: string,
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    _maxBytes?: number,
    options?: RunOptions,
  ): Promise<CommandOutput> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls.push({
      executable,
      args: [...args],
      ...(options !== undefined ? { options } : {}),
    });
    // Script command output independently of Git's global query configuration.
    const commandArgs = args[0] === "-c" && args[1] === "diff.autoRefreshIndex=false" ? args.slice(2) : args;
    return this.response(commandArgs);
  }
}
class CapturingRunner implements ProcessRunner {
  readonly calls: Array<{
    readonly args: readonly string[];
    readonly options?: RunOptions;
  }> = [];

  private readonly runner = new BunProcessRunner();

  async run(
    cwd: string,
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    maxBytes?: number,
    options?: RunOptions,
  ): Promise<CommandOutput> {
    this.calls.push({
      args: [...args],
      ...(options !== undefined ? { options } : {}),
    });
    return this.runner.run(cwd, executable, args, signal, maxBytes, options);
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-git-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed (${exitCode}): ${stderr}`);
  return stdout;
}

async function initializeRepository(withHead = true): Promise<string> {
  const root = await temporaryDirectory();
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.name", "Pi Files Test");
  await git(root, "config", "user.email", "pi-files@example.invalid");
  if (!withHead) return root;

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "目录"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored.log\n");
  await writeFile(join(root, "tracked.ts"), "base\n");
  await writeFile(join(root, "deleted.ts"), "remove me\n");
  await writeFile(join(root, "src", "space name.ts"), "space\n");
  await writeFile(join(root, "目录", "文件.ts"), "unicode\n");
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

async function openRepository(
  root: string,
  runner?: ProcessRunner,
): Promise<GitRepository> {
  const repository = await GitRepository.open(root, runner, new AbortController().signal);
  if (!repository) throw new Error("expected a Git repository");
  return repository;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

test("returns undefined outside a Git repository", async () => {
  const root = await temporaryDirectory();
  expect(await GitRepository.open(root, undefined, new AbortController().signal)).toBeUndefined();
});

test("preserves trailing whitespace in the repository root", async () => {
  const rootWithTrailingSpaces = `${resolve("synthetic-repository")}  `;
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${rootWithTrailingSpaces}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("0123456789abcdef\n");
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("refs/heads/main\n");
    }
    return commandOutput();
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  const inspection = await repository.inspect(new AbortController().signal);

  expect(inspection.root).toBe(rootWithTrailingSpaces);
});

test("uses symbolic HEAD structure to recognize an unborn branch", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("", "致命错误：需要一个修订\n", 128);
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("refs/heads/main\n");
    }
    return commandOutput();
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  const inspection = await repository.inspect(new AbortController().signal);

  expect(inspection.hasHead).toBe(false);
  expect(inspection.headIdentity).toBe("branch:main");
  expect(inspection.currentBranch).toBe("main");
  expect(inspection.detachedAt).toBeUndefined();
});

test("surfaces the original verification failure when HEAD is not symbolic", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("", "致命错误：无法验证 HEAD\n", 128);
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("", "", 1);
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  await expect(repository.inspect(new AbortController().signal)).rejects.toThrow(
    /无法验证 HEAD/,
  );
});

test("surfaces structural HEAD inspection failures", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("", "fatal: original failure\n", 128);
    }
    return commandOutput("", "fatal: cannot inspect symbolic HEAD\n", 128);
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  await expect(repository.inspect(new AbortController().signal)).rejects.toThrow(
    /cannot inspect symbolic HEAD/,
  );
});

test("lists local branches in deterministic order and marks the symbolic HEAD", async () => {
  const root = await initializeRepository();
  await git(root, "branch", "feature/ui");
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  expect(await repository.branches(signal)).toEqual({
    branches: [
      { name: "feature/ui", current: false },
      { name: "main", current: true },
    ],
    current: "main",
  });

  const inspection = await repository.inspect(signal);
  expect(inspection.headIdentity).toBe("branch:main");
  expect(inspection.currentBranch).toBe("main");
  expect(inspection.detachedAt).toBeUndefined();
});

test("reports detached HEAD with a short object ID without inventing a branch", async () => {
  const root = await initializeRepository();
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "switch", "--quiet", "--detach", oid);
  const repository = await openRepository(root);

  const snapshot = await repository.branches(new AbortController().signal);

  expect(snapshot.branches).toEqual([{ name: "main", current: false }]);
  expect(snapshot.current).toBeUndefined();
  expect(snapshot.detachedAt).toBe(oid.slice(0, 7));

  const inspection = await repository.inspect(new AbortController().signal);
  expect(inspection.headIdentity).toBe(`detached:${oid}`);
  expect(inspection.currentBranch).toBeUndefined();
  expect(inspection.detachedAt).toBe(oid.slice(0, 7));
});

test("switches to a validated local branch and preserves the new symbolic HEAD", async () => {
  const root = await initializeRepository();
  await git(root, "branch", "feature/ui");
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  await repository.switchBranch("feature/ui", { signal });

  expect((await git(root, "branch", "--show-current")).trim()).toBe("feature/ui");
  expect((await repository.inspect(signal)).headIdentity).toBe("branch:feature/ui");
});

test("refuses a conflicting dirty switch without changing the dirty file", async () => {
  const root = await initializeRepository();
  await git(root, "switch", "--quiet", "-c", "feature/ui");
  await writeFile(join(root, "tracked.ts"), "feature committed\n");
  await git(root, "add", "tracked.ts");
  await git(root, "commit", "--quiet", "-m", "feature change");
  await git(root, "switch", "--quiet", "main");
  await writeFile(join(root, "tracked.ts"), "local dirty content\n");

  const repository = await openRepository(root);
  await expect(
    repository.switchBranch("feature/ui", { signal: new AbortController().signal }),
  ).rejects.toThrow();

  expect(await readFile(join(root, "tracked.ts"), "utf8")).toBe("local dirty content\n");
  expect((await git(root, "branch", "--show-current")).trim()).toBe("main");
});

test("switch execution never invokes a shell or forbidden Git remediation", async () => {
  const root = resolve("scripted-branch-repository");
  const runner = new ScriptedRunner((args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return commandOutput(`${root}\n`);
    }
    if (args[0] === "for-each-ref" || args.includes("refs/heads")) {
      return commandOutput("feature/ui\0main\0");
    }
    if (args[0] === "symbolic-ref") return commandOutput("refs/heads/main\n");
    if (args[0] === "switch") return commandOutput();
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(root, runner, new AbortController().signal);
  if (!repository) throw new Error("expected scripted repository");

  await repository.switchBranch("feature/ui", {
    signal: new AbortController().signal,
  });

  const argv = runner.calls.flatMap(call => [call.executable, ...call.args]).join("\0");
  expect(argv).not.toContain("stash");
  expect(argv).not.toContain("force");
  expect(argv).not.toContain("fetch");
  expect(runner.calls.every(call => call.executable === "git")).toBe(true);
  expect(runner.calls.some(call =>
    call.args.join("\0") === "switch\0--no-guess\0feature/ui"
  )).toBe(true);
});

test("parses NUL-safe numstat paths and keys renames by normalized current path", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("0123456789abcdef\n");
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("refs/heads/main\n");
    }
    if (command === "status\0--porcelain=v1\0-z\0--untracked-files=all") {
      return commandOutput("R  新\tname.ts\0old\nname.ts\0 M plain\\path.ts\0");
    }
    if (command === "ls-files\0-z\0--cached\0--others\0--exclude-standard") {
      return commandOutput("新\tname.ts\0plain\\path.ts\0");
    }
    if (
      command ===
      "diff\0--no-ext-diff\0--no-color\0--numstat\0-z\0HEAD\0--\0."
    ) {
      return commandOutput(
        "2\t1\t\0old\nname.ts\0新\tname.ts\0" +
          "3\t4\tplain\\path.ts\0",
      );
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  const inspection = await repository.inspect(new AbortController().signal);

  expect(inspection.summaryByPath.get("新\tname.ts")).toEqual({
    insertions: 2,
    deletions: 1,
  });
  expect(inspection.summaryByPath.get("plain/path.ts")).toEqual({
    insertions: 3,
    deletions: 4,
  });
  expect(inspection.summary).toEqual({ files: 2, insertions: 5, deletions: 5 });
});

test("moves an old-path-only numstat entry onto the rename current path", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("0123456789abcdef\n");
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("refs/heads/main\n");
    }
    if (command === "status\0--porcelain=v1\0-z\0--untracked-files=all") {
      return commandOutput("R  new.ts\0old.ts\0");
    }
    if (command === "ls-files\0-z\0--cached\0--others\0--exclude-standard") {
      return commandOutput("new.ts\0");
    }
    if (command.startsWith("diff\0")) {
      return commandOutput("0\t5\told.ts\0");
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  const inspection = await repository.inspect(new AbortController().signal);

  expect(inspection.summaryByPath.get("new.ts")).toEqual({
    insertions: 0,
    deletions: 5,
  });
  expect(inspection.summaryByPath.has("old.ts")).toBe(false);
});

test("preserves per-current-path counts for a rename swap cycle", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("0123456789abcdef\n");
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("refs/heads/main\n");
    }
    if (command === "status\0--porcelain=v1\0-z\0--untracked-files=all") {
      return commandOutput("R  b.ts\0a.ts\0R  a.ts\0b.ts\0");
    }
    if (command === "ls-files\0-z\0--cached\0--others\0--exclude-standard") {
      return commandOutput("a.ts\0b.ts\0");
    }
    if (command.startsWith("diff\0")) {
      return commandOutput("2\t1\ta.ts\0" + "3\t4\tb.ts\0");
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  const inspection = await repository.inspect(new AbortController().signal);

  expect(inspection.summaryByPath.get("a.ts")).toEqual({
    insertions: 2,
    deletions: 1,
  });
  expect(inspection.summaryByPath.get("b.ts")).toEqual({
    insertions: 3,
    deletions: 4,
  });
  expect(inspection.summary).toEqual({ files: 2, insertions: 5, deletions: 5 });
});

test("rejects malformed NUL-safe rename numstat records", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("0123456789abcdef\n");
    }
    if (command === "symbolic-ref\0-q\0HEAD") {
      return commandOutput("refs/heads/main\n");
    }
    if (command === "status\0--porcelain=v1\0-z\0--untracked-files=all") {
      return commandOutput(" M tracked.ts\0");
    }
    if (command === "ls-files\0-z\0--cached\0--others\0--exclude-standard") {
      return commandOutput("tracked.ts\0");
    }
    if (command.startsWith("diff\0")) {
      return commandOutput("1\t0\t\0old.ts\0");
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");

  await expect(repository.inspect(new AbortController().signal)).rejects.toThrow(
    /rename.*current path/i,
  );
});

test("inspects visible spaced and Unicode paths while excluding ignored files", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "new.ts"), "new\n");
  await writeFile(join(root, "ignored.log"), "ignored\n");
  const inspection = await (await openRepository(root)).inspect(new AbortController().signal);

  expect(inspection.root).toBe(root);
  expect(inspection.hasHead).toBe(true);
  expect(inspection.allFiles).toContain("src/space name.ts");
  expect(inspection.allFiles).toContain("目录/文件.ts");
  expect(inspection.allFiles).toContain("new.ts");
  expect(inspection.allFiles).not.toContain("ignored.log");
  expect(inspection.allFiles.some((path) => path.startsWith(".git/"))).toBe(false);
});

test("uses live status when previewing after inspection", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "tracked.ts"), "base\n");
  let changed = false;
  const commands: string[] = [];
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    commands.push(command);
    if (command === "rev-parse\0--show-toplevel") return commandOutput(`${root}\n`);
    if (command === "rev-parse\0--verify\0HEAD") return commandOutput("0123456789abcdef\n");
    if (command === "symbolic-ref\0-q\0HEAD") return commandOutput("refs/heads/main\n");
    if (command === "status\0--porcelain=v1\0-z\0--untracked-files=all") {
      return changed ? commandOutput(" M tracked.ts\0") : commandOutput();
    }
    if (command === "ls-files\0-z\0--cached\0--others\0--exclude-standard") {
      return commandOutput("tracked.ts\0");
    }
    if (command.startsWith("diff\0--no-ext-diff\0--no-color\0--numstat")) return commandOutput();
    if (command.startsWith("diff\0--no-ext-diff\0--no-color\0--unified=")) {
      return commandOutput("--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1 +1 @@\n-base\n+changed\n");
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    root,
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");
  await repository.inspect(new AbortController().signal);

  const unchanged = await repository.preview("tracked.ts", new AbortController().signal);
  expect(unchanged).toMatchObject({ kind: "text", lines: ["base"] });

  changed = true;
  await writeFile(join(root, "tracked.ts"), "changed\n");
  const changedPreview = await repository.preview(
    "tracked.ts",
    new AbortController().signal,
  );

  expect(changedPreview).toMatchObject({ kind: "diff" });
  expect(changedPreview.lines).toContain("-base");
  expect(changedPreview.lines).toContain("+changed");
});

test("previews staged plus unstaged edits together against HEAD", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "base\nstaged\n");
  await git(root, "add", "tracked.ts");
  await writeFile(join(root, "tracked.ts"), "base\nstaged\nunstaged\n");

  const preview = await (await openRepository(root)).preview("tracked.ts", new AbortController().signal);

  expect(preview.kind).toBe("diff");
  expect(preview.lines).toContain("+staged");
  expect(preview.lines).toContain("+unstaged");
});

test("widens the diff context on request and rejects unsupported levels", async () => {
  const root = await initializeRepository();
  const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(root, "long.ts"), `${original.join("\n")}\n`);
  await git(root, "add", "long.ts");
  await git(root, "commit", "--quiet", "-m", "long");
  await writeFile(
    join(root, "long.ts"),
    `${original.map(line => (line === "line 10" ? "line ten" : line)).join("\n")}\n`,
  );
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  const narrow = await repository.preview("long.ts", signal);
  const wide = await repository.preview("long.ts", signal, FULL_DIFF_CONTEXT);
  const rejected = await repository.preview("long.ts", signal, 4);

  expect(narrow.lines).toContain("-line 10");
  expect(narrow.lines).toContain(" line 7");
  expect(narrow.lines).not.toContain(" line 1");
  expect(wide.lines).toContain("-line 10");
  expect(wide.lines).toContain(" line 1");
  expect(wide.lines).toContain(" line 20");
  // A level outside the cycle falls back to the default rather than to Git's
  // own error for a malformed `--unified` value.
  expect(rejected.lines).toEqual(narrow.lines);
});

test("previews untracked content and deleted tracked files", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "new.ts"), "first\nsecond\n");
  await rm(join(root, "deleted.ts"));
  const repository = await openRepository(root);

  const added = await repository.preview("new.ts", new AbortController().signal);
  const deleted = await repository.preview("deleted.ts", new AbortController().signal);

  expect(added).toMatchObject({ kind: "text", lines: ["first", "second"], truncated: false });
  expect(deleted.kind).toBe("diff");
  expect(deleted.lines).toContain("-remove me");
});

test("round-trips the current and original Unicode rename paths", async () => {
  const root = await initializeRepository();
  await git(root, "mv", "src/space name.ts", "src/新 name.ts");

  const inspection = await (await openRepository(root)).inspect(new AbortController().signal);

  expect(inspection.allFiles).toContain("src/新 name.ts");
  expect(inspection.allFiles).not.toContain("src/space name.ts");
  expect(inspection.changes.get("src/新 name.ts")).toMatchObject({
    oldPath: "src/space name.ts",
    status: "R",
  });
  expect(inspection.summaryByPath.get("src/新 name.ts")).toEqual({
    insertions: 0,
    deletions: 0,
  });
  expect(inspection.summaryByPath.has("src/space name.ts")).toBe(false);
});

test("combines split delete/add numstat entries for a staged rename rewritten unstaged", async () => {
  const root = await initializeRepository();
  const oldLines = Array.from({ length: 120 }, (_, index) => `old ${index}`);
  await writeFile(join(root, "rewrite-old.ts"), `${oldLines.join("\n")}\n`);
  await git(root, "add", "rewrite-old.ts");
  await git(root, "commit", "--quiet", "-m", "add rewrite fixture");
  await git(root, "mv", "rewrite-old.ts", "rewrite-new.ts");
  const newLines = Array.from({ length: 90 }, (_, index) => `new ${index}`);
  await writeFile(join(root, "rewrite-new.ts"), `${newLines.join("\n")}\n`);

  const inspection = await (await openRepository(root)).inspect(
    new AbortController().signal,
  );

  expect(inspection.changes.get("rewrite-new.ts")).toMatchObject({
    oldPath: "rewrite-old.ts",
    status: "R",
  });
  expect(inspection.summaryByPath.get("rewrite-new.ts")).toEqual({
    insertions: 90,
    deletions: 120,
  });
  expect(inspection.summaryByPath.has("rewrite-old.ts")).toBe(false);
  expect(inspection.summary).toEqual({
    files: 1,
    insertions: 90,
    deletions: 120,
  });
});

test("computes HEAD-relative tracked totals plus untracked text insertions", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "base\nstaged\n");
  await git(root, "add", "tracked.ts");
  await writeFile(join(root, "tracked.ts"), "base\nstaged\nunstaged\n");
  await rm(join(root, "deleted.ts"));
  await writeFile(join(root, "new.ts"), "first\nsecond\n");

  const inspection = await (await openRepository(root)).inspect(new AbortController().signal);

  expect(inspection.summary).toEqual({ files: 3, insertions: 4, deletions: 1 });
  expect(inspection.summaryByPath.get("tracked.ts")).toEqual({
    insertions: 2,
    deletions: 0,
  });
  expect(inspection.summaryByPath.get("deleted.ts")).toEqual({
    insertions: 0,
    deletions: 1,
  });
  expect(inspection.summaryByPath.get("new.ts")).toEqual({
    insertions: 2,
    deletions: 0,
  });
});

test("uses content previews and text-line insertions when HEAD is absent", async () => {
  const root = await initializeRepository(false);
  await writeFile(join(root, "alpha.ts"), "alpha\nbeta\n");
  await writeFile(join(root, "image.bin"), new Uint8Array([4, 0, 5]));
  const repository = await openRepository(root);

  const inspection = await repository.inspect(new AbortController().signal);
  const preview = await repository.preview("alpha.ts", new AbortController().signal);

  expect(inspection.hasHead).toBe(false);
  expect(inspection.summary).toEqual({ files: 2, insertions: 2, deletions: 0 });
  expect(inspection.summaryByPath.get("alpha.ts")).toEqual({
    insertions: 2,
    deletions: 0,
  });
  expect(inspection.summaryByPath.get("image.bin")).toEqual({
    insertions: 0,
    deletions: 0,
  });
  expect(preview).toMatchObject({ kind: "text", lines: ["alpha", "beta"] });
});

test("returns binary metadata and truncates text input over one MiB", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "binary.dat"), new Uint8Array([1, 0, 2, 3]));
  await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_PREVIEW_BYTES + 1, 97));
  const repository = await openRepository(root);

  const binary = await repository.preview("binary.dat", new AbortController().signal);
  const large = await repository.preview("large.txt", new AbortController().signal);

  expect(binary).toEqual({ path: "binary.dat", kind: "binary", lines: ["Binary file"], byteSize: 4, truncated: false });
  expect(large).toMatchObject({ kind: "text", byteSize: MAX_PREVIEW_BYTES + 1, truncated: true });
});

test("hashes content, returns null for missing files, and refuses path escape", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);
  const signal = new AbortController().signal;
  const first = await repository.contentHash("tracked.ts", signal);
  await writeFile(join(root, "tracked.ts"), "changed\n");
  const second = await repository.contentHash("tracked.ts", signal);

  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(second).toMatch(/^[a-f0-9]{64}$/);
  expect(second).not.toBe(first);
  expect(await repository.contentHash("missing.ts", signal)).toBeNull();
  await expect(repository.contentHash("../outside", signal)).rejects.toThrow(/outside/i);
});

test("propagates cancellation from repository operations", async () => {
  const repository = await openRepository(await initializeRepository());
  const controller = new AbortController();
  controller.abort();

  await expect(repository.inspect(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(repository.preview("tracked.ts", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(repository.contentHash("tracked.ts", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("history preserves NUL-safe Git fields in newest-first order", async () => {
  const root = await initializeRepository();
  const subject = "subject with spaces\tand 日本語";
  await writeFile(join(root, "tracked.ts"), "base\nhistory change\n");
  await git(root, "add", "tracked.ts");
  await git(root, "commit", "--quiet", "-m", subject);
  const repository = await openRepository(root) as unknown as GitHistoryRepository;

  const history = await repository.history(new AbortController().signal);
  const newest = history.entries[0];
  expect(history.entries.map(entry => entry.subject)).toEqual([subject, "initial"]);

  expect(history.truncated).toBe(false);
  expect(newest).toMatchObject({ subject, author: "Pi Files Test" });
  expect(newest?.oid).toMatch(/^[a-f0-9]{40}$/);
  expect(newest?.shortOid.length).toBeGreaterThan(0);
  expect(newest?.oid.startsWith(newest.shortOid)).toBe(true);
  expect(newest?.authoredAt).toBe(Number((await git(root, "log", "-1", "--format=%at")).trim()));
});

test("history caps its log at 200 entries and reports truncation", async () => {
  const root = await initializeRepository();
  for (let index = 1; index <= 200; index += 1) {
    await git(root, "commit", "--allow-empty", "--quiet", "-m", `commit-${index}`);
  }
  const repository = await openRepository(root) as unknown as GitHistoryRepository;

  const history = await repository.history(new AbortController().signal);

  expect(history.entries).toHaveLength(200);
  expect(history.truncated).toBe(true);
  expect(history.entries[0]?.subject).toBe("commit-200");
  expect(history.entries.at(-1)?.subject).toBe("commit-1");
}, { timeout: 30_000 });

test("returns an ordinary commit patch without git-show metadata", async () => {
  const root = await initializeRepository();
  const subject = "metadata must not leak";
  await writeFile(join(root, "tracked.ts"), "base\ncommitted line\n");
  await git(root, "add", "tracked.ts");
  await git(root, "commit", "--quiet", "-m", subject);
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  const repository = await openRepository(root) as unknown as GitHistoryRepository;

  const diff = await repository.commitDiff(oid, new AbortController().signal);
  const rendered = diff.lines.join("\n");

  expect(diff).toMatchObject({ oid, kind: "diff", truncated: false });
  expect(rendered).toContain("diff --git a/tracked.ts b/tracked.ts");
  expect(rendered).toContain("+committed line");
  expect(rendered).not.toContain(`commit ${oid}`);
  expect(rendered).not.toContain(subject);
});

test("keeps Git's default show semantics for a merge commit", async () => {
  const root = await initializeRepository();
  const mainBranch = (await git(root, "branch", "--show-current")).trim();
  await git(root, "checkout", "--quiet", "-b", "feature");
  await writeFile(join(root, "feature.ts"), "feature\n");
  await git(root, "add", "feature.ts");
  await git(root, "commit", "--quiet", "-m", "feature commit");
  await git(root, "checkout", "--quiet", mainBranch);
  await writeFile(join(root, "main.ts"), "main\n");
  await git(root, "add", "main.ts");
  await git(root, "commit", "--quiet", "-m", "main commit");
  await git(root, "merge", "--no-ff", "--quiet", "-m", "merge commit", "feature");
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  const repository = await openRepository(root) as unknown as GitHistoryRepository;

  const diff = await repository.commitDiff(oid, new AbortController().signal);
  const expected = (await git(root, "show", "--format=", "--no-ext-diff", "--no-color", `--unified=${DEFAULT_DIFF_CONTEXT}`, oid, "--")).trimEnd();

  expect(diff).toMatchObject({ oid, kind: "diff" });
  expect(diff.lines.join("\n")).toBe(expected);
});

test("inspects a repository containing an untracked nested repository", async () => {
  const root = await initializeRepository();
  await mkdir(join(root, "nested"), { recursive: true });
  await git(join(root, "nested"), "init", "--quiet");
  await writeFile(join(root, "nested", "inner.ts"), "inner\n");
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  const inspection = await repository.inspect(signal);

  expect(inspection.changes.get("nested")).toMatchObject({ status: "?" });
  expect(inspection.allFiles).toContain("nested");
  expect(await repository.contentHash("nested", signal)).toBeNull();
  const preview = await repository.preview("nested", signal);
  expect(preview.kind).toBe("error");
  expect(preview.error).toMatch(/not a regular file/);
});

async function withBareRemote(): Promise<{ root: string; remote: string }> {
  const root = await initializeRepository();
  const remote = await temporaryDirectory();
  await git(remote, "init", "--bare", "--quiet");
  // A bare repository defaults its HEAD to `master`, which leaves a clone of it
  // without a checkout once the only branch is `main`.
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "remote", "add", "origin", remote);
  return { root, remote };
}

test("commits only the selected paths and leaves the rest staged out", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "changed\n");
  await writeFile(join(root, "src", "space name.ts"), "changed too\n");
  await writeFile(join(root, "unselected.ts"), "not selected\n");
  const repository = await openRepository(root);

  const result = await repository.commit({
    message: "feat: pick two files",
    paths: ["tracked.ts", "src/space name.ts"],
    signal: new AbortController().signal,
  });

  expect(result.dryRun).toBe(false);
  expect(result.files).toBe(2);
  expect((await git(root, "rev-list", "--count", "HEAD")).trim()).toBe("2");
  const committed = await git(root, "show", "--pretty=", "--name-only", "HEAD");
  expect(committed.split("\n").filter(line => line.length > 0).sort()).toEqual([
    "src/space name.ts",
    "tracked.ts",
  ]);
  const status = await git(root, "status", "--porcelain=v1");
  expect(status).toContain("unselected.ts");
});
test("treats pathspec metacharacters as literal selected paths", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "[ab].ts"), "selected\n");
  await writeFile(join(root, "a.ts"), "unselected\n");
  await writeFile(join(root, "a..b.ts"), "also selected\n");
  const repository = await openRepository(root);

  await repository.commit({
    message: "feat: literal path",
    paths: ["[ab].ts", "a..b.ts"],
    signal: new AbortController().signal,
  });

  expect(await git(root, "show", "--pretty=", "--name-only", "HEAD")).toContain("[ab].ts");
  expect(await git(root, "show", "--pretty=", "--name-only", "HEAD")).not.toContain("a.ts");
  expect(await git(root, "status", "--porcelain=v1")).toContain("a.ts");
});


test("refuses a commit with no selected paths", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "changed\n");
  const repository = await openRepository(root);

  await expect(
    repository.commit({ message: "feat: nothing", paths: [], signal: new AbortController().signal }),
  ).rejects.toThrow(/at least one file/);
});

test("refuses a commit whose selection left no recordable change", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);

  await expect(
    repository.commit({
      message: "feat: clean tree",
      paths: ["tracked.ts"],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/None of the selected files/);
});

test("refuses a selection that tries to escape the repository", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "changed\n");
  const repository = await openRepository(root);

  await expect(
    repository.commit({
      message: "feat: escape",
      paths: ["../outside.ts"],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/unsafe path/);
  await expect(
    repository.commit({
      message: "  ",
      paths: ["tracked.ts"],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(TypeError);
});

test("a dry run stages the selection and reports without committing", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "changed\n");
  const repository = await openRepository(root);

  const result = await repository.commit({
    message: "feat: dry run",
    paths: ["tracked.ts"],
    dryRun: true,
    signal: new AbortController().signal,
  });

  expect(result.dryRun).toBe(true);
  expect(result.output).toContain("tracked.ts");
  expect((await git(root, "rev-list", "--count", "HEAD")).trim()).toBe("1");
  // Staging happened, so the confirmation reports what would really be committed.
  expect(await git(root, "diff", "--cached", "--name-only")).toContain("tracked.ts");
});

test("records a rename instead of a delete plus an add", async () => {
  const root = await initializeRepository();
  await git(root, "mv", "src/space name.ts", "src/renamed.ts");
  const repository = await openRepository(root);

  await repository.commit({
    message: "refactor: rename",
    paths: ["src/renamed.ts"],
    signal: new AbortController().signal,
  });

  const names = await git(root, "show", "--pretty=", "--name-status", "HEAD");
  expect(names).toMatch(/^R\d*\s+src\/space name\.ts\s+src\/renamed\.ts$/mu);
});

test("stages a tracked deletion the panel selected", async () => {
  const root = await initializeRepository();
  await rm(join(root, "deleted.ts"));
  const repository = await openRepository(root);

  await repository.commit({
    message: "chore: drop",
    paths: ["deleted.ts"],
    signal: new AbortController().signal,
  });

  expect(await git(root, "show", "--pretty=", "--name-status", "HEAD")).toMatch(/^D\s+deleted\.ts$/m);
});

test("reports whether the index still matches HEAD", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  expect(await repository.indexMatchesHead(signal)).toBe(true);
  await writeFile(join(root, "tracked.ts"), "changed\n");
  await git(root, "add", "tracked.ts");
  expect(await repository.indexMatchesHead(signal)).toBe(false);
  await git(root, "commit", "--quiet", "-m", "staged");
  expect(await repository.indexMatchesHead(signal)).toBe(true);
});

test("cache fingerprints track staged content but ignore unstaged edits and index stat refreshes", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);
  const signal = new AbortController().signal;
  const original = await repository.cacheFingerprint(signal);
  expect(original.headOid).toBe((await git(root, "rev-parse", "HEAD")).trim());

  await writeFile(join(root, "tracked.ts"), "edited\n");
  await repository.inspect(signal);
  expect(await repository.cacheFingerprint(signal)).toEqual(original);

  await git(root, "add", "tracked.ts");
  const staged = await repository.cacheFingerprint(signal);
  expect(staged.headOid).toBe(original.headOid);
  expect(staged.indexFingerprint).not.toBe(original.indexFingerprint);

  await git(root, "update-index", "--refresh");
  expect(await repository.cacheFingerprint(signal)).toEqual(staged);
});

test("repeated review after commit and amend does not rewrite the watched index", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);
  const signal = new AbortController().signal;
  const indexPath = join(root, ".git", "index");

  for (const amend of [false, true]) {
    if (amend) {
      await git(root, "commit", "--quiet", "--amend", "-m", "amended");
    } else {
      await writeFile(join(root, "tracked.ts"), "committed\n");
      await git(root, "add", "tracked.ts");
      await git(root, "commit", "--quiet", "-m", "committed");
    }
    const before = await readFile(indexPath);
    const modifiedAt = (await stat(indexPath)).mtimeMs;
    // Same content with new file stat data: status must not refresh the index.
    const changedTime = new Date(amend ? "2002-01-01T00:00:00Z" : "2001-01-01T00:00:00Z");
    await utimes(join(root, "tracked.ts"), changedTime, changedTime);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      expect((await repository.inspect(signal)).changes.size).toBe(0);
      await repository.cacheFingerprint(signal);
      expect(await readFile(indexPath)).toEqual(before);
      expect((await stat(indexPath)).mtimeMs).toBe(modifiedAt);
    }
  }
});

test("reads the HEAD subject and body so an amend can replay the body", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);

  await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: subject line", "-m", "body line one\nbody line two");
  const message = await repository.headMessage(new AbortController().signal);

  expect(message?.subject).toBe("feat: subject line");
  expect(message?.body).toBe("body line one\nbody line two");
  expect(message?.pushed).toBe(false);
});

test("has no HEAD message on an unborn branch or a detached HEAD", async () => {
  const unborn = await openRepository(await initializeRepository(false));
  expect(await unborn.headMessage(new AbortController().signal)).toBeUndefined();

  const root = await initializeRepository();
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "checkout", "--quiet", oid);
  const detached = await openRepository(root);
  expect(await detached.headMessage(new AbortController().signal)).toBeUndefined();
});

test("amend replaces only the subject and preserves the raw body", async () => {
  const root = await initializeRepository();
  await git(
    root,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "feat: old title",
    "-m",
    "first paragraph with trailing spaces  \n\n# body comment\nlast paragraph",
  );
  const repository = await openRepository(root);
  const signal = new AbortController().signal;
  const before = (await git(root, "log", "-1", "--format=%B")).replace(/\n$/u, "");

  const result = await repository.amend({
    subject: "feat: new title",
    signal,
  });

  expect(result.subject).toBe("feat: new title");
  expect((await git(root, "log", "-1", "--format=%B")).replace(/\n$/u, "")).toBe(
    before.replace(/^feat: old title/u, "feat: new title"),
  );
  expect((await git(root, "log", "-1", "--format=%s")).trim()).toBe("feat: new title");
  expect((await git(root, "log", "-1", "--format=%H")).trim()).toBe(result.oid);
});

test("amend refuses while staged changes would be folded in, and changes nothing", async () => {
  const root = await initializeRepository();
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: title");
  await writeFile(join(root, "tracked.ts"), "staged work\n");
  await git(root, "add", "tracked.ts");
  const repository = await openRepository(root);
  const headBefore = await git(root, "rev-parse", "HEAD");

  await expect(
    repository.amend({ subject: "feat: renamed", signal: new AbortController().signal }),
  ).rejects.toThrow(/Staged changes/);

  expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(headBefore.trim());
  expect(await git(root, "log", "-1", "--format=%s")).toBe("feat: title\n");
});

test("amend refuses an unborn branch and a detached HEAD", async () => {
  const unborn = await openRepository(await initializeRepository(false));
  await expect(
    unborn.amend({ subject: "feat: nothing to amend", signal: new AbortController().signal }),
  ).rejects.toThrow(/unborn HEAD/);

  const root = await initializeRepository();
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "checkout", "--quiet", oid);
  const detached = await openRepository(root);
  await expect(
    detached.amend({ subject: "feat: orphan", signal: new AbortController().signal }),
  ).rejects.toThrow(/detached HEAD/);
});

test("reports no upstream until the branch tracks one", async () => {
  const root = await initializeRepository();
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  expect(await repository.upstream(signal)).toBeUndefined();
  await expect(repository.pushPlan({ signal })).rejects.toThrow(/tracks no upstream/);
});

test("plans a push with the commits the remote does not have", async () => {
  const { root } = await withBareRemote();
  await git(root, "push", "--quiet", "-u", "origin", "main");
  await writeFile(join(root, "tracked.ts"), "second\n");
  await git(root, "commit", "--quiet", "-a", "-m", "feat: local only");
  const repository = await openRepository(root);

  const plan = await repository.pushPlan({ signal: new AbortController().signal });

  expect(plan.branch).toBe("main");
  expect(plan.upstream).toBe("origin/main");
  expect(plan.ahead).toBe(1);
  expect(plan.behind).toBe(0);
  expect(plan.truncated).toBe(false);
  expect(plan.commits).toHaveLength(1);
  expect(plan.commits[0]?.subject).toBe("feat: local only");
});

test("counts a remote that moved ahead as behind", async () => {
  const { root, remote } = await withBareRemote();
  await git(root, "push", "--quiet", "-u", "origin", "main");

  const other = await temporaryDirectory();
  await git(other, "clone", "--quiet", remote, "clone");
  await git(join(other, "clone"), "config", "user.name", "Other");
  await git(join(other, "clone"), "config", "user.email", "other@example.invalid");
  await git(join(other, "clone"), "commit", "--quiet", "--allow-empty", "-m", "feat: remote work");
  await git(join(other, "clone"), "push", "--quiet", "origin", "main");
  await git(root, "fetch", "--quiet", "origin");
  const repository = await openRepository(root);
  const plan = await repository.pushPlan({ signal: new AbortController().signal });

  expect(plan.behind).toBe(1);
  expect(plan.ahead).toBe(0);
});

test("pushes the branch to its remote and then reports nothing pending", async () => {
  const { root } = await withBareRemote();
  await git(root, "push", "--quiet", "-u", "origin", "main");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: to push");
  const runner = new CapturingRunner();
  const repository = await openRepository(root, runner);
  const signal = new AbortController().signal;

  const result = await repository.push({ branch: "main", upstream: "origin/main", signal });

  expect(result.branch).toBe("main");
  expect(result.upstream).toBe("origin/main");
  expect(await repository.pushPlan({ signal }).then(plan => plan.ahead)).toBe(0);
  const pushCall = runner.calls.find(call => call.args[0] === "push");
  expect(pushCall?.options?.env).toEqual({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  });
});
test("pushes to the exact configured upstream branch name", async () => {
  const { root, remote } = await withBareRemote();
  await git(root, "push", "--quiet", "-u", "origin", "main:release");
  await git(root, "checkout", "--quiet", "-b", "aaa");
  await git(root, "push", "--quiet", "-u", "origin", "aaa:other");
  await git(root, "checkout", "--quiet", "main");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: to release");
  const repository = await openRepository(root);
  const signal = new AbortController().signal;

  const plan = await repository.pushPlan({ signal });
  expect(plan.upstream).toBe("origin/release");
  const upstream = plan.upstream;
  if (upstream === undefined) throw new Error("Expected a configured upstream push plan");
  await repository.push({ branch: "main", upstream, signal });

  expect((await git(remote, "rev-parse", "refs/heads/release")).trim()).toBe(
    (await git(root, "rev-parse", "HEAD")).trim(),
  );
  await expect(git(remote, "rev-parse", "refs/heads/main")).rejects.toThrow();
  await git(root, "config", "branch.main.merge", "refs/heads/other");
  await expect(
    repository.push({ branch: "main", upstream, signal }),
  ).rejects.toThrow(/upstream changed/);
});
test("refuses an interactive custom SSH transport without overriding it", async () => {
  const root = await initializeRepository();
  await git(root, "remote", "add", "origin", "ssh://git@example.invalid/repo.git");
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(root, "branch", "--set-upstream-to=origin/main", "main");
  await git(root, "config", "core.sshCommand", "ssh -oBatchMode=no");
  const repository = await openRepository(root);

  await expect(
    repository.push({
      branch: "main",
      upstream: "origin/main",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/custom SSH transports are not overridden/);
});
test("refuses a remote with multiple push URLs", async () => {
  const root = await initializeRepository();
  const first = await temporaryDirectory();
  const second = await temporaryDirectory();
  await git(first, "init", "--bare", "--quiet");
  await git(second, "init", "--bare", "--quiet");
  await git(root, "remote", "add", "origin", first);
  await git(root, "config", "--add", "remote.origin.pushurl", first);
  await git(root, "config", "--add", "remote.origin.pushurl", second);
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(root, "branch", "--set-upstream-to=origin/main", "main");
  const repository = await openRepository(root);

  await expect(
    repository.push({
      branch: "main",
      upstream: "origin/main",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/multiple push URLs/);

  await expect(git(first, "rev-parse", "refs/heads/main")).rejects.toThrow();
  await expect(git(second, "rev-parse", "refs/heads/main")).rejects.toThrow();
});


test("a non-fast-forward push is rejected and never forced", async () => {
  const { root, remote } = await withBareRemote();
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: second");
  await git(root, "push", "--quiet", "-u", "origin", "main");
  await git(root, "reset", "--quiet", "--hard", "HEAD~1");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: rewritten history");
  const repository = await openRepository(root);
  const headBefore = (await git(root, "rev-parse", "HEAD")).trim();
  const remoteBefore = (await git(remote, "rev-parse", "main")).trim();

  await expect(
    repository.push({ branch: "main", upstream: "origin/main", signal: new AbortController().signal }),
  ).rejects.toThrow(/failed with exit code/);

  expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(headBefore);
  expect((await git(remote, "rev-parse", "main")).trim()).toBe(remoteBefore);
});

test("push refuses a detached HEAD and a branch that is not checked out", async () => {
  const root = await initializeRepository();
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "checkout", "--quiet", oid);
  const detached = await openRepository(root);

  await expect(
    detached.push({ branch: "main", upstream: "origin/main", signal: new AbortController().signal }),
  ).rejects.toThrow(/detached HEAD/);

  await git(root, "checkout", "--quiet", "-b", "other");
  const onOther = await openRepository(root);
  await expect(
    onOther.push({ branch: "main", upstream: "origin/main", signal: new AbortController().signal }),
  ).rejects.toThrow(/not "main"/);
});

test("cancelling a write operation aborts instead of reporting success", async () => {
  const root = await initializeRepository();
  await writeFile(join(root, "tracked.ts"), "changed\n");
  const repository = await openRepository(root);
  const controller = new AbortController();
  controller.abort();

  await expect(
    repository.commit({
      message: "feat: cancelled",
      paths: ["tracked.ts"],
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect((await git(root, "rev-list", "--count", "HEAD")).trim()).toBe("1");
});
test("redacts credential URLs from push failures", async () => {
  const root = resolve("credential-redaction-repository");
  const oid = "0123456789abcdef0123456789abcdef01234567";
  const runner = new ScriptedRunner(args => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") return commandOutput(`${root}\n`);
    if (command === "rev-parse\0--verify\0HEAD") return commandOutput(`${oid}\n`);
    if (command === "symbolic-ref\0-q\0HEAD") return commandOutput("refs/heads/main\n");
    if (command === "rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}") {
      return commandOutput("origin/main\n");
    }
    if (command === "for-each-ref\0--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)\0refs/heads/main") {
      return commandOutput("refs/heads/main\0origin\0refs/heads/main\n");
    }
    if (command === "check-ref-format\0refs/heads/main") return commandOutput();
    if (command === "remote\0get-url\0--push\0--all\0origin") {
      return commandOutput("https://alice:secret@example.invalid/repo.git\n");
    }
    if (command === "config\0--get\0core.sshCommand") return commandOutput("", "", 1);
    if (args[0] === "push") {
      return commandOutput(
        "",
        "fatal: Authentication failed for 'https://alice:secret@example.invalid/repo.git'",
        1,
      );
    }
    throw new Error(`unexpected Git command: ${command}`);
  });
  const repository = await GitRepository.open(root, runner, new AbortController().signal);
  if (!repository) throw new Error("expected a scripted repository");

  const failure = await repository.push({
    branch: "main",
    upstream: "origin/main",
    signal: new AbortController().signal,
  }).then(
    () => undefined,
    error => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain("alice");
  expect((failure as Error).message).not.toContain("secret");
  expect((failure as Error).message).toContain("[redacted]");
});