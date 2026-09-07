import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runGit(root: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).arrayBuffer(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "pi-files-review-smoke-"));
try {
  await mkdir(join(root, "src", "auth"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(
    join(root, "src", "auth", "login.ts"),
    "export function login(name: string): string {\n  return `welcome ${name}`;\n}\n",
  );
  await writeFile(
    join(root, "tests", "auth.test.ts"),
    "import { expect, test } from \"bun:test\";\nimport { login } from \"../src/auth/login\";\n\ntest(\"greets the authenticated user\", () => {\n  expect(login(\"Ada\")).toBe(\"welcome Ada\");\n});\n",
  );
  await writeFile(join(root, ".gitignore"), "node_modules/\n");

  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.name", "Pi Files Review"]);
  await runGit(root, ["config", "user.email", "pi-files-review@example.invalid"]);
  await runGit(root, ["config", "core.autocrlf", "false"]);
  await runGit(root, ["add", "--", ".gitignore", "src/auth/login.ts", "tests/auth.test.ts"]);
  await runGit(root, ["commit", "-m", "fixture baseline"]);

  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "src", "auth", "token.ts"),
    "export const token = \"staged-token\";\n",
  );
  await writeFile(
    join(root, "assets", "payload.bin"),
    new Uint8Array([0x50, 0x49, 0x00, 0x46, 0x49, 0x4c, 0x45, 0x53]),
  );
  await runGit(root, ["add", "--", "src/auth/token.ts", "assets/payload.bin"]);

  await writeFile(
    join(root, "src", "auth", "login.ts"),
    "export function login(name: string): string {\n  const normalized = name.trim();\n  return `welcome back ${normalized}`;\n}\n",
  );
  await writeFile(join(root, "src", "说明.txt"), "这是一个未跟踪的文件。\n");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "ignored.js"), "throw new Error(\"ignored\");\n");

  const escapedRoot = root.replaceAll("'", "''");
  console.log(root);
  console.log(`Remove-Item -LiteralPath '${escapedRoot}' -Recurse -Force`);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}
