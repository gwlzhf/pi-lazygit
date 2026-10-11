import { BunProcessRunner } from "../src/git/process";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AmendOptions,
  AmendResult,
  ChangeRecord,
  CommitDiffPreview,
  CommitOptions,
  CommitResult,
  FilePreview,
  GitBranchSnapshot,
  GitLogSnapshot,
  HeadMessage,
  ProjectSnapshot,
  PushOptions,
  PushPlan,
  PushResult,
  RevertOptions,
  RevertResult,
  RefreshOptions,
  StatusCode,
  SwitchBranchOptions,
} from "../src/contracts";
import type { GitRepository, RepositoryInspection } from "../src/git/repository";
import { createBaselineCacheStore, type BaselineCacheStore } from "../src/model/cache-store";
import { BaselineStore, type SerializedBaseline } from "../src/model/baseline";
import {
  clearProjectBaselineCache,
  clearSessionBaselines,
  createReviewSource,
  prepareSessionBaseline,
  ProjectReviewSource,
  setSessionBaselineCacheEnabled,
  type ReviewSourceFactories,
} from "../src/review-source";
const temporaryCacheRoots: string[] = [];

function change(path: string, status: StatusCode): ChangeRecord {
  return { path, index: status, worktree: " ", status };
}

function inspection(
  root: string,
  records: readonly ChangeRecord[],
  summaryByPath: RepositoryInspection["summaryByPath"],
  overrides: Partial<RepositoryInspection> = {},
): RepositoryInspection {
  const changes = new Map(records.map((record) => [record.path, record]));
  let insertions = 0;
  let deletions = 0;
  for (const summary of summaryByPath.values()) {
    insertions += summary.insertions;
    deletions += summary.deletions;
  }
  return {
    root,
    hasHead: true,
    headIdentity: "branch:main",
    currentBranch: "main",
    allFiles: records.map((record) => record.path),
    changes,
    summary: { files: changes.size, insertions, deletions },
    summaryByPath,
    ...overrides,
  };
}

function preview(path: string): FilePreview {
  return {
    path,
    kind: "text",
    lines: [` 1 | ${path}`],
    byteSize: path.length,
    truncated: false,
  };
}

interface FakeGit {
  inspect(signal: AbortSignal): Promise<RepositoryInspection>;
  contentHash(path: string, signal: AbortSignal): Promise<string | null>;
  preview(path: string, signal: AbortSignal): Promise<FilePreview>;
  history(signal: AbortSignal): Promise<GitLogSnapshot>;
  commitDiff(
    oid: string,
    signal: AbortSignal,
    contextLines?: number,
  ): Promise<CommitDiffPreview>;
  branches(signal: AbortSignal): Promise<GitBranchSnapshot>;
  switchBranch(name: string, options: SwitchBranchOptions): Promise<void>;
  headMessage(signal: AbortSignal): Promise<HeadMessage | undefined>;
  commit(options: CommitOptions): Promise<CommitResult>;
  amend(options: AmendOptions): Promise<AmendResult>;
  pushPlan(options: RefreshOptions): Promise<PushPlan>;
  push(options: PushOptions): Promise<PushResult>;
  revert(options: RevertOptions): Promise<RevertResult>;
  cacheFingerprint(signal: AbortSignal): Promise<{ readonly headOid?: string; readonly indexFingerprint: string }>;
}

function unusedGitOperations(): Pick<
  FakeGit,
  | "history"
  | "commitDiff"
  | "branches"
  | "switchBranch"
  | "headMessage"
  | "commit"
  | "amend"
  | "pushPlan"
  | "push"
  | "revert"
  | "cacheFingerprint"
> {
  return {
    async history() {
      throw new Error("Git history is not used by this test");
    },
    async commitDiff() {
      throw new Error("Git commit diffs are not used by this test");
    },
    async branches() {
      throw new Error("Git branches are not used by this test");
    },
    async switchBranch() {
      throw new Error("Git branch switching is not used by this test");
    },
    async headMessage() {
      throw new Error("The HEAD message is not used by this test");
    },
    async commit() {
      throw new Error("Git commits are not used by this test");
    },
    async amend() {
      throw new Error("Git amends are not used by this test");
    },
    async pushPlan() {
      throw new Error("The Git push plan is not used by this test");
    },
    async push() {
      throw new Error("Git pushes are not used by this test");
    },
    async revert() {
      throw new Error("Git reverts are not used by this test");
    },
    async cacheFingerprint(receivedSignal) {
      receivedSignal.throwIfAborted();
      return { headOid: "test-head", indexFingerprint: "test-index" };
    },
  };
}

type FakeGitBackend = Pick<
  GitRepository,
  | "inspect"
  | "contentHash"
  | "preview"
  | "history"
  | "commitDiff"
  | "branches"
  | "switchBranch"
  | "headMessage"
  | "commit"
  | "amend"
  | "pushPlan"
  | "push"
  | "revert"
  | "cacheFingerprint"
>;

function gitFactories(git: FakeGit, openCalls: string[]): ReviewSourceFactories {
  return {
    openGit: async (cwd, _runner, signal) => {
      signal.throwIfAborted();
      openCalls.push(cwd);
      return git as FakeGitBackend;
    },
    createFilesystem: () => {
      throw new Error("filesystem fallback was not expected");
    },
  };
}

const signal = new AbortController().signal;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}
async function temporaryCacheStore(): Promise<BaselineCacheStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-baseline-cache-"));
  temporaryCacheRoots.push(root);
  return createBaselineCacheStore({ resolveAgentDir: async () => root });
}
function fakeCacheStore(overrides: Partial<BaselineCacheStore> = {}): BaselineCacheStore {
  return {
    load: async () => undefined,
    save: async () => {},
    remove: async () => {},
    clearForRoot: async () => {},
    ...overrides,
  };
}

test("rehydrates a cross-session baseline and compares current content against it", async () => {
  const root = resolve("cross-session-cache");
  const cacheStore = await temporaryCacheStore();
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let content = "session-start";
  let hashCalls = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return content;
    },
    async preview(path) {
      return preview(path);
    },
    async cacheFingerprint(receivedSignal) {
      receivedSignal.throwIfAborted();
      return { headOid: "head-1", indexFingerprint: "tree-1" };
    },
  };
  const factories: ReviewSourceFactories = {
    ...gitFactories(git, []),
    cacheStore,
  };

  const first = createReviewSource(root, undefined, factories);
  const cold = await first.refresh({ signal });
  expect(cold.sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(1);
  await clearSessionBaselines(true);

  content = "changed-between-sessions";
  const second = createReviewSource(root, undefined, factories);
  const warm = await second.refresh({ signal });

  expect(warm.baselineEstablishedAt).toBe(cold.baselineEstablishedAt);
  expect([...warm.sessionChanges]).toEqual([[dirty.path, dirty]]);
  expect(hashCalls).toBe(2);
});

test("preserves session baseline across index changes and recaptures after HEAD changes", async () => {
  const root = resolve("fingerprint-invalidation");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let fingerprint = { headOid: "head-1", indexFingerprint: "tree-1" };
  let hashCalls = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return `content-${hashCalls}`;
    },
    async preview(path) {
      return preview(path);
    },
    async cacheFingerprint(receivedSignal) {
      receivedSignal.throwIfAborted();
      return fingerprint;
    },
  };
  const source = createReviewSource(root, undefined, gitFactories(git, []));

  await source.refresh({ signal });
  fingerprint = { headOid: "head-1", indexFingerprint: "tree-2" };
  const staged = await source.refresh({ signal });
  expect([...staged.sessionChanges]).toEqual([[dirty.path, dirty]]);
  fingerprint = { headOid: "head-2", indexFingerprint: "tree-2" };
  expect((await source.refresh({ signal })).sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(3);
});
test("fingerprint failures preserve the active baseline and session edits", async () => {
  const root = resolve("fingerprint-failure");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let fingerprintCalls = 0;
  let hashCalls = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return `content-${hashCalls}`;
    },
    async preview(path) {
      return preview(path);
    },
    async cacheFingerprint(receivedSignal) {
      receivedSignal.throwIfAborted();
      fingerprintCalls += 1;
      if (fingerprintCalls > 1) throw new Error("fingerprint unavailable");
      return { headOid: "head-1", indexFingerprint: "tree-1" };
    },
  };
  const source = createReviewSource(root, undefined, gitFactories(git, []));
  const cold = await source.refresh({ signal });
  const warm = await source.refresh({ signal });

  expect(warm.baselineEstablishedAt).toBe(cold.baselineEstablishedAt);
  expect([...warm.sessionChanges]).toEqual([[dirty.path, dirty]]);
  expect(hashCalls).toBe(2);
});


test("disabled caching skips disk access while cache failures fall back to capture", async () => {
  const root = resolve("cache-disabled-failure");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let hashCalls = 0;
  let loadCalls = 0;
  let saveCalls = 0;
  const cacheStore = fakeCacheStore({
    async load() {
      loadCalls += 1;
      throw new Error("cache read unavailable");
    },
    async save() {
      saveCalls += 1;
      throw new Error("cache write unavailable");
    },
  });
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return "content";
    },
    async preview(path) {
      return preview(path);
    },
  };
  const factories: ReviewSourceFactories = {
    ...gitFactories(git, []),
    cacheStore,
  };

  const disabled = createReviewSource(root, undefined, factories, false);
  await disabled.refresh({ signal });
  expect([loadCalls, saveCalls, hashCalls]).toEqual([0, 0, 1]);

  await clearSessionBaselines(false);
  setSessionBaselineCacheEnabled(true);
  const failing = createReviewSource(root, undefined, factories, true);
  await expect(failing.refresh({ signal })).resolves.toMatchObject({ kind: "git" });
  expect([loadCalls, saveCalls, hashCalls]).toEqual([1, 1, 2]);
});
test("rejects a malformed cached baseline and falls back to live capture", async () => {
  const root = resolve("malformed-baseline-cache");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let hashCalls = 0;
  const cacheStore = fakeCacheStore({
    async load() {
      return {
        root,
        headIdentity: "branch:main",
        establishedAt: 1,
        entries: [{ path: "../outside", status: "M", hash: "bad" }],
      } as SerializedBaseline;
    },
  });
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return "live-content";
    },
    async preview(path) {
      return preview(path);
    },
  };
  const source = createReviewSource(root, undefined, {
    ...gitFactories(git, []),
    cacheStore,
  }, true);

  const result = await source.refresh({ signal });
  expect(result.kind).toBe("git");
  expect(result.sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(1);
});

test("serializes clear-cache after outstanding writes and prevents repopulation", async () => {
  const root = resolve("clear-cache-race");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  const saveStarted = deferred<void>();
  const finishSave = deferred<void>();
  let clearCalls = 0;
  const cacheStore = fakeCacheStore({
    async save() {
      saveStarted.resolve(undefined);
      await finishSave.promise;
    },
    async clearForRoot() {
      clearCalls += 1;
    },
  });
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return "content";
    },
    async preview(path) {
      return preview(path);
    },
  };
  const source = createReviewSource(root, undefined, {
    ...gitFactories(git, []),
    cacheStore,
  }, true);

  const refresh = source.refresh({ signal });
  await saveStarted.promise;
  const clear = clearProjectBaselineCache(root);
  await Promise.resolve();
  expect(clearCalls).toBe(0);
  finishSave.resolve(undefined);
  await Promise.all([refresh, clear]);
  expect(clearCalls).toBe(1);
});

test("awaits pending cache writes before clearing session baselines", async () => {
  const root = resolve("shutdown-cache-race");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  const saveStarted = deferred<void>();
  const finishSave = deferred<void>();
  const cacheStore = fakeCacheStore({
    async save() {
      saveStarted.resolve(undefined);
      await finishSave.promise;
    },
  });
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return "content";
    },
    async preview(path) {
      return preview(path);
    },
  };
  const source = createReviewSource(root, undefined, {
    ...gitFactories(git, []),
    cacheStore,
  }, true);

  const refresh = source.refresh({ signal });
  await saveStarted.promise;
  let shutdownDone = false;
  const shutdown = clearSessionBaselines(true).then(() => {
    shutdownDone = true;
  });
  await Promise.resolve();
  expect(shutdownDone).toBe(false);
  finishSave.resolve(undefined);
  await Promise.all([refresh, shutdown]);
  expect(shutdownDone).toBe(true);
});

test("a changed cross-session HEAD identity misses the prior cached baseline", async () => {
  const root = resolve("cross-session-head-invalidation");
  const cacheStore = await temporaryCacheStore();
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let headOid = "head-old";
  let hashCalls = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return `content-${hashCalls}`;
    },
    async preview(path) {
      return preview(path);
    },
    async cacheFingerprint(receivedSignal) {
      receivedSignal.throwIfAborted();
      return { headOid, indexFingerprint: "tree-1" };
    },
  };
  const factories: ReviewSourceFactories = {
    ...gitFactories(git, []),
    cacheStore,
  };

  await createReviewSource(root, undefined, factories).refresh({ signal });
  await clearSessionBaselines(true);
  headOid = "head-new";
  const restarted = createReviewSource(root, undefined, factories);
  expect((await restarted.refresh({ signal })).sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(2);
});


test("a changed cross-session index fingerprint misses the prior cached baseline", async () => {
  const root = resolve("cross-session-index-invalidation");
  const cacheStore = await temporaryCacheStore();
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let indexFingerprint = "tree-before-stage";
  let hashCalls = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return `content-${hashCalls}`;
    },
    async preview(path) {
      return preview(path);
    },
    async cacheFingerprint(receivedSignal) {
      receivedSignal.throwIfAborted();
      return { headOid: "head-1", indexFingerprint };
    },
  };
  const factories: ReviewSourceFactories = {
    ...gitFactories(git, []),
    cacheStore,
  };

  await createReviewSource(root, undefined, factories).refresh({ signal });
  await clearSessionBaselines(true);
  indexFingerprint = "tree-after-stage";
  const restarted = createReviewSource(root, undefined, factories);
  expect((await restarted.refresh({ signal })).sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(2);
});

afterEach(async () => {
  setSessionBaselineCacheEnabled(true);
  await clearSessionBaselines(true);
  for (const root of temporaryCacheRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git-only operations delegate to a discovered Git backend and watch its repository root", async () => {
  const cwd = resolve("repository-child");
  const repositoryRoot = resolve("repository-root");
  const oid = "0123456789abcdef";
  const historyCalls: AbortSignal[] = [];
  const diffCalls: Array<{ readonly oid: string; readonly signal: AbortSignal; readonly context: number | undefined }> = [];
  const branchCalls: AbortSignal[] = [];
  const switchCalls: Array<{ readonly name: string; readonly signal: AbortSignal }> = [];
  const watchCalls: Array<{ readonly root: string; readonly options: unknown }> = [];
  const history = {
    entries: [{
      oid,
      shortOid: oid.slice(0, 7),
      subject: "Add history",
      author: "Ada",
      authoredAt: 1_700_000_000,
    }],
    truncated: false,
  };
  const commitPreview = {
    oid,
    kind: "diff" as const,
    lines: ["diff --git a/file.ts b/file.ts"],
    truncated: false,
  };
  const branchSnapshot: GitBranchSnapshot = {
    branches: [
      { name: "feature/ui", current: false },
      { name: "main", current: true },
    ],
    current: "main",
  };
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      return inspection(repositoryRoot, [], new Map());
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return null;
    },
    async preview(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return preview(path);
    },
    async history(receivedSignal) {
      historyCalls.push(receivedSignal);
      return history;
    },
    async commitDiff(receivedOid, receivedSignal, context) {
      diffCalls.push({ oid: receivedOid, signal: receivedSignal, context });
      return commitPreview;
    },
    async branches(receivedSignal) {
      branchCalls.push(receivedSignal);
      return branchSnapshot;
    },
    async switchBranch(name, options) {
      switchCalls.push({ name, signal: options.signal });
    },
  };
  const source = new ProjectReviewSource(
    cwd,
    new BaselineStore(),
    undefined,
    {
      ...gitFactories(git, []),
      async watchGit(root, options) {
        watchCalls.push({ root, options });
      },
    },
  );
  const branchSignal = new AbortController().signal;
  expect(await source.branches({ signal: branchSignal })).toBe(branchSnapshot);
  await source.switchBranch("feature/ui", { signal: branchSignal });
  const historySignal = new AbortController().signal;
  const previewSignal = new AbortController().signal;
  const watchOptions = {
    signal: new AbortController().signal,
    onChange() {},
    onError() {},
  };
  expect(branchCalls).toEqual([branchSignal]);
  expect(switchCalls).toEqual([{ name: "feature/ui", signal: branchSignal }]);

  expect(await source.history({ signal: historySignal })).toBe(history);
  expect(await source.commitDiff(oid, { signal: previewSignal, diffContext: 25 })).toBe(commitPreview);
  await source.watch(watchOptions);

  expect(historyCalls).toEqual([historySignal]);
  expect(diffCalls).toEqual([{ oid, signal: previewSignal, context: 25 }]);
  expect(watchCalls).toEqual([{ root: repositoryRoot, options: watchOptions }]);
});

test("Git-only operations reject for a discovered filesystem backend without starting a watcher", async () => {
  const root = resolve("filesystem-git-only-operations");
  let discoveryCalls = 0;
  const watchCalls: unknown[] = [];
  const source = new ProjectReviewSource(
    root,
    new BaselineStore(),
    undefined,
    {
      async openGit() {
        discoveryCalls += 1;
        return undefined;
      },
      createFilesystem: () => ({
        async inspect() {
          return { allFiles: [], truncated: false };
        },
        async preview(path) {
          return preview(path);
        },
      }),
      async watchGit(_root, options) {
        watchCalls.push(options);
      },
    },
  );

  await source.refresh({ signal });
  await expect(source.history({ signal })).rejects.toThrow("Git repository");
  await expect(source.commitDiff("not-a-commit", { signal })).rejects.toThrow("Git repository");
  await expect(source.branches({ signal })).rejects.toThrow("Git repository");
  await expect(source.switchBranch("main", { signal })).rejects.toThrow("Git repository");
  await expect(source.watch({ signal, onChange() {}, onError() {} })).rejects.toThrow("Git repository");

  expect(discoveryCalls).toBe(1);
  expect(watchCalls).toEqual([]);
});

test("prepareSessionBaseline is reused by refresh and preview delegates to the active Git backend", async () => {
  const root = resolve("prepared-repository");
  const preexisting = change("src/preexisting.ts", "M");
  const added = change("src/added.ts", "A");
  let currentInspection = inspection(
    root,
    [preexisting],
    new Map([[preexisting.path, { insertions: 5, deletions: 1 }]]),
  );
  const hashes = new Map([[preexisting.path, "before-session"]]);
  const openCalls: string[] = [];
  const inspectCalls: AbortSignal[] = [];
  const hashCalls: string[] = [];
  const previewCalls: string[] = [];
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      inspectCalls.push(receivedSignal);
      return currentInspection;
    },
    async contentHash(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls.push(path);
      return hashes.get(path) ?? null;
    },
    async preview(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      previewCalls.push(path);
      return preview(path);
    },
  };
  const factories = gitFactories(git, openCalls);

  await prepareSessionBaseline(root, undefined, factories);
  currentInspection = inspection(
    root,
    [preexisting, added],
    new Map([
      [preexisting.path, { insertions: 5, deletions: 1 }],
      [added.path, { insertions: 3, deletions: 0 }],
    ]),
  );
  hashes.set(added.path, "added-after-session-start");

  const source = createReviewSource(join(root, "."), undefined, factories);
  const snapshot = await source.refresh({ signal });
  const filePreview = await source.preview(added.path, { signal });
  expect(snapshot.workspaceSummaryByPath).toEqual(currentInspection.summaryByPath);

  expect(openCalls).toEqual([root, root]);
  expect(inspectCalls).toHaveLength(2);
  expect(hashCalls).toEqual([preexisting.path, preexisting.path]);
  expect(snapshot.kind).toBe("git");
  expect(snapshot.workspaceChanges).toEqual(currentInspection.changes);
  expect([...snapshot.sessionChanges]).toEqual([[added.path, added]]);
  expect(snapshot.workspaceSummary).toEqual({ files: 2, insertions: 8, deletions: 1 });
  expect(snapshot.sessionSummary).toEqual({ files: 1, insertions: 3, deletions: 0 });
  expect(typeof snapshot.baselineEstablishedAt).toBe("number");
  expect(filePreview).toEqual(preview(added.path));
  expect(previewCalls).toEqual([added.path]);
});

test("Git content previews read bounded working-tree content while default previews remain diffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-content-"));
  temporaryCacheRoots.push(root);
  const runner = new BunProcessRunner();
  const controller = new AbortController();
  const runGit = async (...args: string[]) => {
    const result = await runner.run(root, "git", args, controller.signal);
    expect(result.exitCode).toBe(0);
    return result;
  };
  await runGit("init");
  await runGit("config", "user.name", "Test");
  await runGit("config", "user.email", "test@example.com");
  const filePath = join(root, "sample.txt");
  await writeFile(filePath, "original line\n");
  await runGit("add", "sample.txt");
  await runGit("commit", "-m", "initial");
  await writeFile(filePath, "updated line\nsecond line\n");

  const source = createReviewSource(root);
  const defaultPreview = await source.preview("sample.txt", { signal: controller.signal });
  const contentPreview = await source.preview("sample.txt", {
    signal: controller.signal,
    mode: "content",
  });
  expect(defaultPreview.kind).toBe("diff");
  expect(contentPreview.kind).toBe("text");
  expect(contentPreview.lines).toEqual(["updated line", "second line"]);
  expect(contentPreview.lines).not.toEqual(defaultPreview.lines);
  expect(contentPreview.truncated).toBe(false);
});

test("first refresh in a repository establishes one baseline before returning session changes", async () => {
  const root = resolve("first-visited-repository");
  const dirty = change("src/dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 2, deletions: 1 }]]),
  );
  let hash = "first-visit";
  const hashCalls: string[] = [];
  let inspectCount = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      inspectCount += 1;
      return currentInspection;
    },
    async contentHash(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls.push(path);
      return hash;
    },
    async preview(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return preview(path);
    },
  };
  const source = new ProjectReviewSource(
    root,
    new BaselineStore(),
    undefined,
    gitFactories(git, []),
  );
  const first = await source.refresh({ signal });
  hash = "edited-after-first-visit";
  const second = await source.refresh({ signal });

  expect(first.sessionChanges.size).toBe(0);
  expect(first.sessionSummary).toEqual({ files: 0, insertions: 0, deletions: 0 });
  expect(typeof first.baselineEstablishedAt).toBe("number");
  expect(second.baselineEstablishedAt).toBe(first.baselineEstablishedAt);
  expect([...second.sessionChanges]).toEqual([[dirty.path, dirty]]);
  expect(second.sessionSummary).toEqual({ files: 1, insertions: 2, deletions: 1 });
  expect(inspectCount).toBe(2);
  expect(hashCalls).toEqual([dirty.path, dirty.path]);
});

test("first refresh on a feature branch captures a separate baseline from main", async () => {
  const root = resolve("branch-specific-source-baselines");
  const dirty = change("src/dirty.ts", "M");
  const mainInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 2, deletions: 1 }]]),
    { headIdentity: "branch:main", currentBranch: "main" },
  );
  const featureInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 8, deletions: 0 }]]),
    { headIdentity: "branch:feature", currentBranch: "feature" },
  );
  let currentInspection = mainInspection;
  const baselines = new BaselineStore();
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return currentInspection === mainInspection ? "main-hash" : "feature-hash";
    },
    async preview(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return preview(path);
    },
  };
  const source = new ProjectReviewSource(root, baselines, undefined, gitFactories(git, []));

  const main = await source.refresh({ signal });
  currentInspection = featureInspection;
  const feature = await source.refresh({ signal });

  expect(main.sessionChanges.size).toBe(0);
  expect(feature.sessionChanges.size).toBe(0);
  expect(baselines.get(root, "branch:main")?.headIdentity).toBe("branch:main");
  expect(baselines.get(root, "branch:feature")?.headIdentity).toBe("branch:feature");
});

test("filesystem refresh has no Git changes or baseline and re-inspects the cached backend", async () => {
  const root = resolve("filesystem-project");
  const inspectSignals: AbortSignal[] = [];
  const previewCalls: string[] = [];
  let createCount = 0;
  const factories: ReviewSourceFactories = {
    async openGit(_cwd, _runner, receivedSignal) {
      receivedSignal.throwIfAborted();
      return undefined;
    },
    createFilesystem(receivedRoot) {
      createCount += 1;
      expect(receivedRoot).toBe(root);
      return {
        async inspect(receivedSignal) {
          inspectSignals.push(receivedSignal);
          return { allFiles: ["README.md", "src/main.ts"], truncated: false };
        },
        async preview(path, receivedSignal) {
          receivedSignal.throwIfAborted();
          previewCalls.push(path);
          return preview(path);
        },
      };
    },
  };
  const source = new ProjectReviewSource(root, new BaselineStore(), undefined, factories);

  const first = await source.refresh({ signal });
  const second = await source.refresh({ signal });
  const filePreview = await source.preview("README.md", { signal });

  const expected: ProjectSnapshot = {
    kind: "filesystem",
    root,
    hasHead: false,
    allFiles: ["README.md", "src/main.ts"],
    workspaceChanges: new Map(),
    sessionChanges: new Map(),
    workspaceSummary: { files: 0, insertions: 0, deletions: 0 },
    workspaceSummaryByPath: new Map(),
    sessionSummary: { files: 0, insertions: 0, deletions: 0 },
    truncated: false,
  };
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  expect(first).not.toHaveProperty("baselineEstablishedAt");
  expect(createCount).toBe(1);
  expect(inspectSignals).toHaveLength(2);
  expect(filePreview).toEqual(preview("README.md"));
  expect(previewCalls).toEqual(["README.md"]);
});

test("refresh rediscovers Git and replaces the backend across filesystem and Git transitions", async () => {
  const root = resolve("transition-project");
  const tracked = change("tracked.ts", "M");
  const gitInspection = inspection(
    root,
    [tracked],
    new Map([[tracked.path, { insertions: 1, deletions: 0 }]]),
  );
  const previewBackends: string[] = [];
  let discoveryCount = 0;
  let filesystemCount = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      return gitInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return "tracked";
    },
    async preview(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      previewBackends.push("git");
      return preview(path);
    },
  };
  const factories: ReviewSourceFactories = {
    async openGit(_cwd, _runner, receivedSignal) {
      receivedSignal.throwIfAborted();
      discoveryCount += 1;
      return discoveryCount === 2 ? git : undefined;
    },
    createFilesystem() {
      filesystemCount += 1;
      return {
        async inspect(receivedSignal) {
          receivedSignal.throwIfAborted();
          return { allFiles: ["plain.txt"], truncated: false };
        },
        async preview(path, receivedSignal) {
          receivedSignal.throwIfAborted();
          previewBackends.push("filesystem");
          return preview(path);
        },
      };
    },
  };
  const source = new ProjectReviewSource(root, new BaselineStore(), undefined, factories);

  expect((await source.refresh({ signal })).kind).toBe("filesystem");
  expect((await source.refresh({ signal })).kind).toBe("git");
  await source.preview(tracked.path, { signal });
  expect((await source.refresh({ signal })).kind).toBe("filesystem");
  await source.preview("plain.txt", { signal });

  expect(discoveryCount).toBe(3);
  expect(filesystemCount).toBe(2);
  expect(previewBackends).toEqual(["git", "filesystem"]);
});

test("refresh replaces a cached Git backend when repository discovery reports a different root", async () => {
  const firstRoot = resolve("first-root");
  const secondRoot = resolve("second-root");
  const previewBackends: string[] = [];
  let discoveryCount = 0;
  const makeGit = (root: string, label: string): FakeGit => ({
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      return inspection(root, [], new Map());
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      return null;
    },
    async preview(path, receivedSignal) {
      receivedSignal.throwIfAborted();
      previewBackends.push(label);
      return preview(path);
    },
  });
  const firstGit = makeGit(firstRoot, "first");
  const secondGit = makeGit(secondRoot, "second");
  const factories: ReviewSourceFactories = {
    async openGit() {
      discoveryCount += 1;
      return discoveryCount === 1 ? firstGit : secondGit;
    },
    createFilesystem: () => {
      throw new Error("filesystem fallback was not expected");
    },
  };
  const source = new ProjectReviewSource(firstRoot, new BaselineStore(), undefined, factories);

  expect((await source.refresh({ signal })).root).toBe(firstRoot);
  expect((await source.refresh({ signal })).root).toBe(secondRoot);
  await source.preview("file.ts", { signal });

  expect(previewBackends).toEqual(["second"]);
});

test("one aborted waiter does not cancel a shared baseline capture or another waiter", async () => {
  const root = resolve("concurrent-baseline");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  const hashResult = deferred<string | null>();
  const captureStarted = deferred<AbortSignal>();
  const secondInspection = deferred<void>();
  let inspected = 0;
  let hashCalls = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      inspected += 1;
      if (inspected === 2) secondInspection.resolve(undefined);
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      hashCalls += 1;
      captureStarted.resolve(receivedSignal);
      return hashResult.promise;
    },
    async preview(path) {
      return preview(path);
    },
  };
  const factories = gitFactories(git, []);
  const baselines = new BaselineStore();
  const firstSource = new ProjectReviewSource(root, baselines, undefined, factories);
  const secondSource = new ProjectReviewSource(root, baselines, undefined, factories);
  const firstController = new AbortController();
  const secondController = new AbortController();

  const firstRefresh = firstSource.refresh({ signal: firstController.signal });
  const captureSignal = await captureStarted.promise;
  const secondRefresh = secondSource.refresh({ signal: secondController.signal });
  await secondInspection.promise;
  await Promise.resolve();
  const abortReason = new DOMException("first waiter stopped", "AbortError");
  firstController.abort(abortReason);

  await expect(firstRefresh).rejects.toBe(abortReason);
  expect(captureSignal).not.toBe(firstController.signal);
  expect(captureSignal).not.toBe(secondController.signal);
  expect(captureSignal.aborted).toBe(false);
  hashResult.resolve("captured");
  const second = await secondRefresh;

  expect(second.sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(2);
});

test("a refresh joining baseline capture compares changes inspected after capture started", async () => {
  const root = resolve("joining-baseline-refresh");
  const dirty = change("dirty.ts", "M");
  const added = change("added.ts", "A");
  const initialInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  const joinedInspection = inspection(
    root,
    [dirty, added],
    new Map([
      [dirty.path, { insertions: 1, deletions: 0 }],
      [added.path, { insertions: 2, deletions: 0 }],
    ]),
  );
  const hashResult = deferred<string | null>();
  const captureStarted = deferred<void>();
  const secondInspection = deferred<void>();
  let inspected = 0;
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect(receivedSignal) {
      receivedSignal.throwIfAborted();
      inspected += 1;
      if (inspected === 2) {
        secondInspection.resolve(undefined);
        return joinedInspection;
      }
      return initialInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      captureStarted.resolve(undefined);
      return hashResult.promise;
    },
    async preview(path) {
      return preview(path);
    },
  };
  const factories = gitFactories(git, []);
  const baselines = new BaselineStore();
  const firstSource = new ProjectReviewSource(root, baselines, undefined, factories);
  const secondSource = new ProjectReviewSource(root, baselines, undefined, factories);

  const firstRefresh = firstSource.refresh({ signal });
  await captureStarted.promise;
  const secondRefresh = secondSource.refresh({ signal });
  await secondInspection.promise;
  hashResult.resolve("captured");

  const [first, second] = await Promise.all([firstRefresh, secondRefresh]);
  expect(first.sessionChanges.size).toBe(0);
  expect([...second.sessionChanges]).toEqual([[added.path, added]]);
  expect(second.sessionSummary).toEqual({ files: 1, insertions: 2, deletions: 0 });
});

test("a live caller retries after a canceled shared capture", async () => {
  const root = resolve("retry-canceled-capture");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let hashCalls = 0;
  const canceled = new DOMException("capture canceled", "AbortError");
  const git: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash() {
      hashCalls += 1;
      if (hashCalls === 1) throw canceled;
      return "captured-on-retry";
    },
    async preview(path) {
      return preview(path);
    },
  };
  const source = new ProjectReviewSource(
    root,
    new BaselineStore(),
    undefined,
    gitFactories(git, []),
  );

  await expect(source.refresh({ signal })).rejects.toBe(canceled);
  const retried = await source.refresh({ signal });

  expect(retried.sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(2);
});

test("clearSessionBaselines aborts and isolates an outstanding capture from the next session", async () => {
  const root = resolve("rotated-session");
  const dirty = change("dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  const staleHash = deferred<string | null>();
  const staleCaptureStarted = deferred<AbortSignal>();
  let discoveryCount = 0;
  let hashCalls = 0;
  const staleGit: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      hashCalls += 1;
      staleCaptureStarted.resolve(receivedSignal);
      return staleHash.promise;
    },
    async preview(path) {
      return preview(path);
    },
  };
  const freshGit: FakeGit = {
    ...unusedGitOperations(),
    async inspect() {
      return currentInspection;
    },
    async contentHash(_path, receivedSignal) {
      receivedSignal.throwIfAborted();
      hashCalls += 1;
      return "fresh-session";
    },
    async preview(path) {
      return preview(path);
    },
  };
  const factories: ReviewSourceFactories = {
    async openGit() {
      discoveryCount += 1;
      return discoveryCount === 1 ? staleGit : freshGit;
    },
    createFilesystem: () => {
      throw new Error("filesystem fallback was not expected");
    },
  };

  const staleSource = createReviewSource(root, undefined, factories);
  const staleRefresh = staleSource.refresh({ signal });
  const staleCaptureSignal = await staleCaptureStarted.promise;
  await clearSessionBaselines();
  expect(staleCaptureSignal.aborted).toBe(true);

  const freshSource = createReviewSource(root, undefined, factories);
  expect(freshSource).not.toBe(staleSource);
  const freshSnapshot = await freshSource.refresh({ signal });
  staleHash.resolve("late-old-session");
  await expect(staleRefresh).rejects.toMatchObject({ name: "AbortError" });

  expect(freshSnapshot.sessionChanges.size).toBe(0);
  expect(hashCalls).toBe(2);
});

test("clearSessionBaselines clears the canonical source and baseline registries", async () => {
  const root = resolve("registry-project");
  const dirty = change("src/dirty.ts", "M");
  const currentInspection = inspection(
    root,
    [dirty],
    new Map([[dirty.path, { insertions: 1, deletions: 0 }]]),
  );
  let openCount = 0;
  let hashCount = 0;
  const factories: ReviewSourceFactories = {
    async openGit(_cwd, _runner, receivedSignal) {
      receivedSignal.throwIfAborted();
      openCount += 1;
      return {
        ...unusedGitOperations(),
        async inspect() {
          return currentInspection;
        },
        async contentHash() {
          hashCount += 1;
          return "dirty-content";
        },
        async preview(path) {
          return preview(path);
        },
      };
    },
    createFilesystem: () => {
      throw new Error("filesystem fallback was not expected");
    },
  };

  const first = createReviewSource(root, undefined, factories);
  const same = createReviewSource(join(root, "."), undefined, factories);
  expect(same).toBe(first);
  await first.refresh({ signal });

  await clearSessionBaselines();
  const replacement = createReviewSource(root, undefined, factories);
  expect(replacement).not.toBe(first);
  await replacement.refresh({ signal });

  expect(openCount).toBe(2);
  expect(hashCount).toBe(2);
});
