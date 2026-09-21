import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DIFF_CONTEXT, FULL_DIFF_CONTEXT, MAX_PREVIEW_BYTES } from "../contracts";
import { GitRepository } from "./repository";
import {
  type CommandOutput,
  type ProcessRunner,
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
  constructor(
    private readonly response: (args: readonly string[]) => CommandOutput,
  ) {}

  async run(
    _cwd: string,
    _executable: string,
    args: readonly string[],
    signal: AbortSignal,
    _maxBytes?: number,
  ): Promise<CommandOutput> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return this.response(args);
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
  await git(root, "init", "--quiet");
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

async function openRepository(root: string): Promise<GitRepository> {
  const repository = await GitRepository.open(root, undefined, new AbortController().signal);
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

test("parses NUL-safe numstat paths and keys renames by normalized current path", async () => {
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") {
      return commandOutput(`${process.cwd()}\n`);
    }
    if (command === "rev-parse\0--verify\0HEAD") {
      return commandOutput("0123456789abcdef\n");
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

test("reuses the latest inspection when previewing an unchanged file", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "tracked.ts"), "content\n");
  const commands: string[] = [];
  const runner = new ScriptedRunner((args) => {
    const command = args.join("\0");
    commands.push(command);
    if (command === "rev-parse\0--show-toplevel") return commandOutput(`${root}\n`);
    if (command === "rev-parse\0--verify\0HEAD") return commandOutput("0123456789abcdef\n");
    if (command === "status\0--porcelain=v1\0-z\0--untracked-files=all") return commandOutput();
    if (command === "ls-files\0-z\0--cached\0--others\0--exclude-standard") {
      return commandOutput("tracked.ts\0");
    }
    if (command.startsWith("diff\0--no-ext-diff\0--no-color\0--numstat")) return commandOutput();
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
  const repository = await GitRepository.open(
    root,
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");
  await repository.inspect(new AbortController().signal);
  commands.length = 0;

  const result = await repository.preview("tracked.ts", new AbortController().signal);

  expect(result).toMatchObject({ kind: "text", lines: ["content"] });
  expect(commands).toEqual([]);
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

test("enumerates local branches in deterministic order and marks the symbolic HEAD", async () => {
  const root = await initializeRepository();
  await git(root, "branch", "-M", "main");
  await git(root, "switch", "-c", "feature/ui");
  await git(root, "switch", "main");

  const repository = await openRepository(root);
  expect(await repository.branches(new AbortController().signal)).toEqual({
    branches: [
      { name: "feature/ui", current: false },
      { name: "main", current: true },
    ],
    current: "main",
  });
});

test("reports detached HEAD separately from selectable local branches", async () => {
  const root = await initializeRepository();
  await git(root, "branch", "-M", "main");
  const oid = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "checkout", "--detach", "--quiet", "HEAD");

  const repository = await openRepository(root);
  const result = await repository.branches(new AbortController().signal);

  expect(result.branches).toEqual([{ name: "main", current: false }]);
  expect(result.current).toBeUndefined();
  expect(result.detachedAt).toBe(oid.slice(0, 7));
});

test("switches to a validated local branch without shell interpolation", async () => {
  const root = await initializeRepository();
  await git(root, "branch", "-M", "main");
  await git(root, "switch", "-c", "feature/ui");
  await git(root, "switch", "main");

  const repository = await openRepository(root);
  await repository.switchBranch("feature/ui", new AbortController().signal);

  expect((await git(root, "branch", "--show-current")).trim()).toBe("feature/ui");
});

test("ordinary Git safety rejects a conflicting dirty switch without losing data", async () => {
  const root = await initializeRepository();
  await git(root, "branch", "-M", "main");
  await git(root, "switch", "-c", "feature/ui");
  await writeFile(join(root, "tracked.ts"), "feature version\n");
  await git(root, "add", "tracked.ts");
  await git(root, "commit", "--quiet", "-m", "feature change");
  await git(root, "switch", "main");
  await writeFile(join(root, "tracked.ts"), "dirty main version\n");

  const repository = await openRepository(root);
  await expect(repository.switchBranch("feature/ui", new AbortController().signal)).rejects.toThrow();
  expect(await readFile(join(root, "tracked.ts"), "utf8")).toBe("dirty main version\n");
  expect((await git(root, "branch", "--show-current")).trim()).toBe("main");
});

test("branch operations use bounded argv execution without stash, force, fetch, or shells", async () => {
  const observed: string[][] = [];
  const runner = new ScriptedRunner((args) => {
    observed.push([...args]);
    const command = args.join("\0");
    if (command === "rev-parse\0--show-toplevel") return commandOutput(`${process.cwd()}\n`);
    if (command === "rev-parse\0--verify\0HEAD") return commandOutput(`${"a".repeat(40)}\n`);
    if (command === "symbolic-ref\0-q\0HEAD") return commandOutput("refs/heads/main\n");
    if (args[0] === "for-each-ref" || args[0] === "branch") {
      return commandOutput("feature/ui\0main\0");
    }
    if (args[0] === "switch") return commandOutput();
    return commandOutput();
  });

  const repository = await GitRepository.open(
    process.cwd(),
    runner,
    new AbortController().signal,
  );
  if (!repository) throw new Error("expected scripted repository");
  await repository.branches(new AbortController().signal);
  await repository.switchBranch("feature/ui", new AbortController().signal);

  const flattened = observed.flat();
  expect(flattened).not.toContain("stash");
  expect(flattened).not.toContain("force");
  expect(flattened).not.toContain("fetch");
  expect(observed.some(args => /(?:^|[\\/])(sh|bash|cmd|powershell)(?:\.exe)?$/iu.test(args[0] ?? ""))).toBe(false);
});
