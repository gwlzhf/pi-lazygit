import { afterEach, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type {
  ChangeRecord,
  FilePreview,
  ProjectSnapshot,
  StatusCode,
} from "./contracts";
import type { RepositoryInspection } from "./git/repository";
import { BaselineStore } from "./model/baseline";
import {
  clearSessionBaselines,
  createReviewSource,
  prepareSessionBaseline,
  ProjectReviewSource,
  type ReviewSourceFactories,
} from "./review-source";

function change(path: string, status: StatusCode): ChangeRecord {
  return { path, index: status, worktree: " ", status };
}

function inspection(
  root: string,
  records: readonly ChangeRecord[],
  summaryByPath: RepositoryInspection["summaryByPath"],
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
    allFiles: records.map((record) => record.path),
    changes,
    summary: { files: changes.size, insertions, deletions },
    summaryByPath,
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
}

function gitFactories(git: FakeGit, openCalls: string[]): ReviewSourceFactories {
  return {
    openGit: async (cwd, _runner, signal) => {
      signal.throwIfAborted();
      openCalls.push(cwd);
      return git;
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

afterEach(() => {
  clearSessionBaselines();
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
  clearSessionBaselines();
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

  clearSessionBaselines();
  const replacement = createReviewSource(root, undefined, factories);
  expect(replacement).not.toBe(first);
  await replacement.refresh({ signal });

  expect(openCount).toBe(2);
  expect(hashCount).toBe(2);
});
