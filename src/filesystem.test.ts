import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PREVIEW_BYTES } from "./contracts";
import { FilesystemProject } from "./filesystem";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix = "pi-files-fs-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("traverses deterministically with normalized relative paths and excludes .git", async () => {
  const root = await temporaryDirectory();
  await mkdir(join(root, "folder"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "z.txt"), "z\n");
  await writeFile(join(root, "A.txt"), "a\n");
  await writeFile(join(root, "folder", "b.txt"), "b\n");
  await writeFile(join(root, ".git", "secret"), "hidden\n");
  const project = new FilesystemProject(root);

  const first = await project.inspect(new AbortController().signal);
  const second = await project.inspect(new AbortController().signal);

  expect(first).toEqual({
    allFiles: ["A.txt", "z.txt", "folder/b.txt"],
    truncated: false,
  });
  expect(second).toEqual(first);
});

test("returns raw logical text lines for the UI numbering boundary", async () => {
  const root = await temporaryDirectory();
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(root, "notes.txt"), `${lines.join("\n")}\n`);

  const preview = await new FilesystemProject(root).preview(
    "notes.txt",
    new AbortController().signal,
  );

  expect(preview).toMatchObject({
    path: "notes.txt",
    kind: "text",
    byteSize: new TextEncoder().encode(`${lines.join("\n")}\n`).byteLength,
    truncated: false,
  });
  expect(preview.lines[0]).toBe("line 1");
  expect(preview.lines[11]).toBe("line 12");
});

test("returns metadata instead of rendering binary bytes", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "asset.bin"), new Uint8Array([1, 0, 2, 3]));

  const preview = await new FilesystemProject(root).preview(
    "asset.bin",
    new AbortController().signal,
  );

  expect(preview).toEqual({
    path: "asset.bin",
    kind: "binary",
    lines: ["Binary file"],
    byteSize: 4,
    truncated: false,
  });
});

test("caps text input at one MiB", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_PREVIEW_BYTES + 32, 97));

  const preview = await new FilesystemProject(root).preview(
    "large.txt",
    new AbortController().signal,
  );

  expect(preview.kind).toBe("text");
  expect(preview.byteSize).toBe(MAX_PREVIEW_BYTES + 32);
  expect(preview.truncated).toBe(true);
  expect(preview.lines).toHaveLength(1);
});

test("throws AbortError when traversal is cancelled", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "file.txt"), "content\n");
  const controller = new AbortController();
  controller.abort();

  await expect(new FilesystemProject(root).inspect(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

test("does not recurse through directory symlinks", async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory("pi-files-outside-");
  await writeFile(join(outside, "outside.txt"), "not in project\n");
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

  const inspection = await new FilesystemProject(root).inspect(
    new AbortController().signal,
  );

  expect(inspection.allFiles).not.toContain("linked/outside.txt");
  expect(inspection.truncated).toBe(false);
});

test("reports truncation through the lowered entry-limit fixture seam", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, "b.txt"), "b");
  await writeFile(join(root, "c.txt"), "c");

  const inspection = await new FilesystemProject(root, 2).inspect(
    new AbortController().signal,
  );

  expect(inspection.allFiles).toEqual(["a.txt", "b.txt"]);
  expect(inspection.truncated).toBe(true);
});

test("refuses preview paths that escape through parent segments or symlinks", async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory("pi-files-secret-");
  await writeFile(join(outside, "secret.txt"), "sensitive\n");
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const project = new FilesystemProject(root);

  const parentEscape = await project.preview(
    "../secret.txt",
    new AbortController().signal,
  );
  const symlinkEscape = await project.preview(
    "escape/secret.txt",
    new AbortController().signal,
  );

  expect(parentEscape).toMatchObject({ kind: "error", truncated: false });
  expect(symlinkEscape).toMatchObject({ kind: "error", truncated: false });
  expect(parentEscape.lines).toEqual([]);
  expect(symlinkEscape.lines).toEqual([]);
});
