import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { SerializedBaseline } from "../../src/model/baseline";
import { createBaselineCacheStore, type BaselineCacheIdentity } from "../../src/model/cache-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-lazygit-cache-test-"));
  temporaryRoots.push(agentDir);
  const root = resolve(agentDir, "repository");
  const identity: BaselineCacheIdentity = {
    canonicalRoot: root,
    headIdentity: "branch:main",
    headOid: "head-a",
    indexFingerprint: "index-a",
  };
  const baseline: SerializedBaseline = {
    root,
    headIdentity: identity.headIdentity,
    establishedAt: 17,
    entries: [{ path: "src/file.ts", status: "M", hash: "hash-a" }],
  };
  const store = createBaselineCacheStore({ resolveAgentDir: async () => agentDir });
  const digest = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  const file = join(agentDir, "pi-lazygit-cache", "v1", `${digest.slice(0, 16)}.json`);
  return { agentDir, root, identity, baseline, store, file };
}

test("versioned cache round-trips a baseline for the matching four-part identity", async () => {
  const { identity, baseline, store } = await fixture();

  await store.save(identity, baseline);

  expect(await store.load(identity)).toEqual(baseline);
});

test("head OID and index fingerprint changes are cache misses", async () => {
  for (const changed of [
    { headOid: "head-b" },
    { indexFingerprint: "index-b" },
  ]) {
    const { identity, baseline, store } = await fixture();
    await store.save(identity, baseline);

    expect(await store.load({ ...identity, ...changed })).toBeUndefined();
    expect(await store.load(identity)).toEqual(baseline);
  }
});

test("head identity and canonical root mismatches are rejected", async () => {
  const { identity, baseline, store, file } = await fixture();
  await store.save(identity, baseline);
  expect(await store.load({ ...identity, headIdentity: "branch:other" })).toBeUndefined();

  const { identity: rootIdentity, baseline: rootBaseline, store: rootStore, file: rootFile } = await fixture();
  await mkdir(join(rootFile, ".."), { recursive: true });
  await writeFile(rootFile, JSON.stringify({
    version: 1,
    identity: { ...rootIdentity, canonicalRoot: resolve(rootIdentity.canonicalRoot, "other") },
    baseline: rootBaseline,
  }), "utf8");
  expect(await rootStore.load(rootIdentity)).toBeUndefined();
});

test("malformed JSON is a harmless miss and is removed", async () => {
  const { identity, store, file } = await fixture();
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "{truncated", "utf8");

  expect(await store.load(identity)).toBeUndefined();
  await expect(readFile(file, "utf8")).rejects.toThrow();
});

test("invalid schema and unsafe baseline paths are discarded", async () => {
  const { identity, store, file } = await fixture();
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 2, identity, baseline: {} }), "utf8");
  expect(await store.load(identity)).toBeUndefined();
  await expect(readFile(file, "utf8")).rejects.toThrow();

  const { identity: matching, baseline, store: matchingStore, file: matchingFile } = await fixture();
  await mkdir(join(matchingFile, ".."), { recursive: true });
  await writeFile(matchingFile, JSON.stringify({
    version: 1,
    identity: matching,
    baseline: { ...baseline, entries: [{ path: "../outside", status: "M", hash: "bad" }] },
  }), "utf8");
  expect(await matchingStore.load(matching)).toBeUndefined();
});

test("atomic replacement of an existing target leaves the newest complete snapshot", async () => {
  const { identity, baseline, store } = await fixture();
  await store.save(identity, baseline);
  const replacement: SerializedBaseline = {
    ...baseline,
    establishedAt: baseline.establishedAt + 1,
    entries: [{ path: "src/file.ts", status: "M", hash: "replacement" }],
  };

  await store.save(identity, replacement);

  expect(await store.load(identity)).toEqual(replacement);
});

test("an interrupted temporary write never obscures the complete target", async () => {
  const { identity, baseline, store, file } = await fixture();
  await store.save(identity, baseline);
  await writeFile(`${file}.tmp-interrupted`, "{partial", "utf8");

  expect(await store.load(identity)).toEqual(baseline);
});

test("concurrent replacements expose only complete snapshots", async () => {
  const { identity, baseline, store } = await fixture();
  const alternatives: readonly SerializedBaseline[] = Array.from({ length: 8 }, (_, index) => ({
    ...baseline,
    establishedAt: index,
    entries: [{ path: "src/file.ts", status: "M" as const, hash: `hash-${index}` }],
  }));

  await Promise.all(alternatives.map((value) => store.save(identity, value)));

  const loaded = await store.load(identity);
  if (loaded === undefined) throw new Error("Concurrent replacement lost the complete cache target");
  expect(alternatives).toContainEqual(loaded);
});

test("clear by root and remove by identity delete the repository entry", async () => {
  const { identity, baseline, store, root, file } = await fixture();
  await store.save(identity, baseline);
  expect((await readdir(join(file, ".."))).length).toBe(1);

  await store.clearForRoot(root);
  expect(await store.load(identity)).toBeUndefined();

  await store.save(identity, baseline);
  await store.remove(identity);
  expect(await store.load(identity)).toBeUndefined();
});

test("path and filesystem failures fall back without throwing", async () => {
  const { identity, baseline, agentDir } = await fixture();
  const fileInsteadOfDirectory = join(agentDir, "not-a-directory");
  await writeFile(fileInsteadOfDirectory, "x", "utf8");
  const store = createBaselineCacheStore({ resolveAgentDir: async () => fileInsteadOfDirectory });

  expect(await store.load(identity)).toBeUndefined();
  await expect(store.save(identity, baseline)).resolves.toBeUndefined();
});
