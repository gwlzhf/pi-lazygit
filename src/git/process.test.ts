import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "./process";

const temporaryDirectories: string[] = [];

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-process-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fixture.js");
  await writeFile(
    path,
    [
      "const mode = process.argv[2];",
      "if (mode === 'args') {",
      "  process.stdout.write(JSON.stringify(process.argv.slice(3)));",
      "  process.stderr.write('diagnostic');",
      "} else if (mode === 'overflow') {",
      "  process.stdout.write('abcdefgh');",
      "  process.stderr.write('problem');",
      "} else if (mode === 'stderr-overflow') {",
      "  process.stderr.write('x'.repeat(70_000));",
      "} else if (mode === 'wait') {",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      "}",
    ].join("\n"),
    "utf8",
  );
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("executes directly and preserves argument boundaries", async () => {
  const fixture = await fixturePath();
  const signal = new AbortController().signal;

  const output = await new BunProcessRunner().run(
    process.cwd(),
    process.execPath,
    [fixture, "args", "value with spaces & an ampersand"],
    signal,
  );

  expect(new TextDecoder().decode(output.stdout)).toBe(
    '["value with spaces & an ampersand"]',
  );
  expect(output.stderr).toBe("diagnostic");
  expect(output.exitCode).toBe(0);
  expect(output.truncated).toBe(false);
});

test("caps stdout while draining the child and reports truncation", async () => {
  const fixture = await fixturePath();

  const output = await new BunProcessRunner().run(
    process.cwd(),
    process.execPath,
    [fixture, "overflow"],
    new AbortController().signal,
    4,
  );

  expect(new TextDecoder().decode(output.stdout)).toBe("abcd");
  expect(output.stderr).toBe("problem");
  expect(output.exitCode).toBe(0);
  expect(output.truncated).toBe(true);
});

test("caps stderr at 64 KiB without treating it as stdout truncation", async () => {
  const fixture = await fixturePath();

  const output = await new BunProcessRunner().run(
    process.cwd(),
    process.execPath,
    [fixture, "stderr-overflow"],
    new AbortController().signal,
  );

  expect(new TextEncoder().encode(output.stderr).byteLength).toBe(64 * 1024);
  expect(output.truncated).toBe(false);
});

test("kills a waiting child and throws AbortError on cancellation", async () => {
  const fixture = await fixturePath();
  const controller = new AbortController();
  const running = new BunProcessRunner().run(
    process.cwd(),
    process.execPath,
    [fixture, "wait"],
    controller.signal,
  );

  controller.abort();

  await expect(running).rejects.toMatchObject({ name: "AbortError" });
});

test("does not spawn when cancellation has already been requested", async () => {
  const fixture = await fixturePath();
  const controller = new AbortController();
  controller.abort();

  await expect(
    new BunProcessRunner().run(
      process.cwd(),
      process.execPath,
      [fixture, "args", "unreachable"],
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
