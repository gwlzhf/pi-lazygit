import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChangeRecord, StatusCode } from "../contracts";
import { BaselineStore, type HashFile } from "./baseline";

function change(path: string, status: StatusCode): ChangeRecord {
  return { path, index: status, worktree: " ", status };
}

function changes(...records: readonly ChangeRecord[]): Map<string, ChangeRecord> {
  return new Map(records.map((record) => [record.path, record]));
}

function fakeHashes(
  values: Map<string, string | null>,
  calls: string[],
): HashFile {
  return async (absolutePath, signal) => {
    signal.throwIfAborted();
    calls.push(absolutePath);
    return values.get(absolutePath) ?? null;
  };
}

test("capture records status and hashes while compare omits an unchanged baseline", async () => {
  const root = resolve("baseline-fixture");
  const initial = changes(
    change("src/a.ts", "M"),
    change("new.txt", "?"),
    change("deleted.txt", "D"),
    change("missing.txt", "M"),
  );
  const values = new Map<string, string | null>([
    [resolve(root, "src/a.ts"), "hash-a"],
    [resolve(root, "new.txt"), "hash-new"],
    [resolve(root, "missing.txt"), null],
  ]);
  const calls: string[] = [];
  const hashFile = fakeHashes(values, calls);
  const store = new BaselineStore();
  const signal = new AbortController().signal;

  const baseline = await store.capture(root, initial, hashFile, signal, 1234);

  expect(baseline.root).toBe(root);
  expect(baseline.establishedAt).toBe(1234);
  expect([...baseline.entries]).toEqual([
    ["src/a.ts", { status: "M", hash: "hash-a" }],
    ["new.txt", { status: "?", hash: "hash-new" }],
    ["deleted.txt", { status: "D", hash: null }],
    ["missing.txt", { status: "M", hash: null }],
  ]);
  expect(store.get(root)).toBe(baseline);
  expect(calls).toEqual([
    resolve(root, "src/a.ts"),
    resolve(root, "new.txt"),
    resolve(root, "missing.txt"),
  ]);

  calls.length = 0;
  expect((await store.compare(root, initial, hashFile, signal)).size).toBe(0);
  expect(calls).toEqual([
    resolve(root, "src/a.ts"),
    resolve(root, "new.txt"),
    resolve(root, "missing.txt"),
  ]);
});

test("compare includes a tracked file that was clean when the baseline was captured", async () => {
  const root = resolve("clean-baseline");
  const store = new BaselineStore();
  const signal = new AbortController().signal;
  const calls: string[] = [];
  const hashFile = fakeHashes(new Map(), calls);
  await store.capture(root, new Map(), hashFile, signal, 10);
  const current = changes(change("src/a.ts", "M"));

  expect(await store.compare(root, current, hashFile, signal)).toEqual(current);
  expect(calls).toEqual([]);
});

test("compare detects content changes in pre-existing dirty files and ignores retained hashes", async () => {
  const root = resolve("dirty-baseline");
  const absolutePath = resolve(root, "src/a.ts");
  const values = new Map<string, string | null>([[absolutePath, "initial"]]);
  const calls: string[] = [];
  const hashFile = fakeHashes(values, calls);
  const store = new BaselineStore();
  const signal = new AbortController().signal;
  const current = changes(change("src/a.ts", "M"));
  await store.capture(root, current, hashFile, signal, 20);

  calls.length = 0;
  expect((await store.compare(root, current, hashFile, signal)).size).toBe(0);
  expect(calls).toEqual([absolutePath]);

  values.set(absolutePath, "changed");
  calls.length = 0;
  expect(await store.compare(root, current, hashFile, signal)).toEqual(current);
  expect(calls).toEqual([absolutePath]);
});

test("compare reports status changes, including deletion, without hashing deleted content", async () => {
  const root = resolve("deletion-baseline");
  const absolutePath = resolve(root, "src/a.ts");
  const values = new Map<string, string | null>([[absolutePath, "initial"]]);
  const calls: string[] = [];
  const hashFile = fakeHashes(values, calls);
  const store = new BaselineStore();
  const signal = new AbortController().signal;
  await store.capture(root, changes(change("src/a.ts", "M")), hashFile, signal);

  calls.length = 0;
  const deleted = changes(change("src/a.ts", "D"));
  expect(await store.compare(root, deleted, hashFile, signal)).toEqual(deleted);
  expect(calls).toEqual([]);
});

test("a dirty file disappears from session changes after content is restored to its baseline hash", async () => {
  const root = resolve("restore-baseline");
  const absolutePath = resolve(root, "src/a.ts");
  const values = new Map<string, string | null>([[absolutePath, "baseline"]]);
  const hashFile = fakeHashes(values, []);
  const store = new BaselineStore();
  const signal = new AbortController().signal;
  const current = changes(change("src/a.ts", "M"));
  await store.capture(root, current, hashFile, signal);

  values.set(absolutePath, "edited-again");
  expect(await store.compare(root, current, hashFile, signal)).toEqual(current);

  values.set(absolutePath, "baseline");
  expect((await store.compare(root, current, hashFile, signal)).size).toBe(0);
  expect((await store.compare(root, new Map(), hashFile, signal)).size).toBe(0);
});

test("Windows repository identity is case-insensitive without changing display casing", async () => {
  if (process.platform !== "win32") return;

  const store = new BaselineStore();
  const root = "C:\\Work\\Repo";
  const baseline = await store.capture(
    root,
    new Map(),
    fakeHashes(new Map(), []),
    new AbortController().signal,
    30,
  );

  expect(store.get("c:\\work\\repo\\.")).toBe(baseline);
  expect(store.get("C:/WORK/REPO")?.root).toBe(root);
});

test("capture rejects paths that could resolve outside the repository before hashing", async () => {
  const root = resolve("invalid-capture-paths");
  const invalidPaths = ["", "/outside", "C:\\outside", "../outside", "src/../../outside"];
  const calls: string[] = [];
  const hashFile = fakeHashes(new Map(), calls);

  for (const path of invalidPaths) {
    const store = new BaselineStore();
    const records = new Map<string, ChangeRecord>([["safe-key", change(path, "M")]]);
    await expect(
      store.capture(root, records, hashFile, new AbortController().signal),
    ).rejects.toThrow();
    expect(store.get(root)).toBeUndefined();
  }
  expect(calls).toEqual([]);
});

test("capture accepts a POSIX filename beginning with a drive-like colon prefix", async () => {
  const root = resolve("colon-filename");
  const calls: string[] = [];
  const hashFile: HashFile = async (absolutePath) => {
    calls.push(absolutePath);
    return "colon-hash";
  };
  const store = new BaselineStore();

  const baseline = await store.capture(
    root,
    changes(change("C:notes.txt", "M")),
    hashFile,
    new AbortController().signal,
  );

  expect(baseline.entries.get("C:notes.txt")).toEqual({
    status: "M",
    hash: "colon-hash",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.endsWith("C:notes.txt")).toBe(true);
});

test("compare rejects invalid current paths before resolving or hashing them", async () => {
  const root = resolve("invalid-compare-paths");
  const invalidPaths = ["", "/outside", "C:\\outside", "../outside", "src/../../outside"];
  const calls: string[] = [];
  const hashFile = fakeHashes(new Map(), calls);
  const store = new BaselineStore();
  const signal = new AbortController().signal;
  await store.capture(root, new Map(), hashFile, signal);

  for (const path of invalidPaths) {
    const records = new Map<string, ChangeRecord>([["safe-key", change(path, "M")]]);
    await expect(store.compare(root, records, hashFile, signal)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

test("capture aborts atomically and compare observes abort signals", async () => {
  const root = resolve("aborted-baseline");
  const store = new BaselineStore();
  const captureController = new AbortController();
  const captureReason = new DOMException("capture stopped", "AbortError");
  const captureHash: HashFile = async () => {
    captureController.abort(captureReason);
    return "uncommitted";
  };

  await expect(
    store.capture(
      root,
      changes(change("src/a.ts", "M")),
      captureHash,
      captureController.signal,
    ),
  ).rejects.toBe(captureReason);
  expect(store.get(root)).toBeUndefined();

  await store.capture(
    root,
    changes(change("src/a.ts", "M")),
    fakeHashes(new Map([[resolve(root, "src/a.ts"), "baseline"]]), []),
    new AbortController().signal,
  );
  const compareController = new AbortController();
  const compareReason = new DOMException("compare stopped", "AbortError");
  compareController.abort(compareReason);
  await expect(
    store.compare(
      root,
      changes(change("src/a.ts", "M")),
      fakeHashes(new Map(), []),
      compareController.signal,
    ),
  ).rejects.toBe(compareReason);
});

test("clear removes every repository baseline", async () => {
  const store = new BaselineStore();
  const signal = new AbortController().signal;
  const hashFile = fakeHashes(new Map(), []);
  await store.capture(resolve("one"), new Map(), hashFile, signal);
  await store.capture(resolve("two"), new Map(), hashFile, signal);

  store.clear();

  expect(store.get(resolve("one"))).toBeUndefined();
  expect(store.get(resolve("two"))).toBeUndefined();
});
