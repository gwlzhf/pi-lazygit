import { relative, resolve } from "node:path";
import {
  emptySummary,
  normalizeProjectPath,
  type AmendOptions,
  type AmendResult,
  type ChangeRecord,
  type ChangeSummary,
  type CommitDiffPreview,
  type CommitOptions,
  type CommitResult,
  type FilePreview,
  type GitBranchSnapshot,
  type GitLogSnapshot,
  type HeadMessage,
  type PreviewOptions,
  type ProjectSnapshot,
  type PushOptions,
  type PushPlan,
  type PushResult,
type RevertOptions,
type RevertResult,
  type RefreshOptions,
  type ReviewSource,
  type SwitchBranchOptions,
  type WatchOptions,
} from "./contracts";
import { FilesystemProject } from "./filesystem";
import { GitRepository, type RepositoryInspection } from "./git/repository";
import type { ProcessRunner } from "./git/process";
import { watchGitRepository } from "./git/watch";
import { createBaselineCacheStore, type BaselineCacheIdentity, type BaselineCacheStore } from "./model/cache-store";
import { BaselineStore } from "./model/baseline";
type GitBackend = Pick<
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
type FilesystemBackend = Pick<FilesystemProject, "inspect" | "preview">;

export interface ReviewSourceFactories {
  readonly openGit: (
    cwd: string,
    runner: ProcessRunner | undefined,
    signal: AbortSignal,
  ) => Promise<GitBackend | undefined>;
  readonly createFilesystem: (root: string) => FilesystemBackend;
  readonly watchGit?: (root: string, options: WatchOptions) => Promise<void>;
  readonly cacheStore?: BaselineCacheStore;
}

type ActiveBackend =
  | {
    readonly kind: "git";
    readonly root: string;
    readonly project: GitBackend;
  }
  | {
    readonly kind: "filesystem";
    readonly root: string;
    readonly project: FilesystemBackend;
  };

interface BackendDiscovery {
  readonly backend: ActiveBackend;
  readonly inspection?: RepositoryInspection;
}

interface CacheFingerprint {
  readonly headOid?: string;
  readonly indexFingerprint: string;
}

interface BaselineCheckpoint {
  readonly root: string;
  readonly headIdentity: string;
  readonly identity?: BaselineCacheIdentity;
  readonly cacheStore?: BaselineCacheStore;
  readonly generation: number;
}

interface BaselineCoordinator {
  readonly controller: AbortController;
  readonly captures: Map<string, Promise<boolean>>;
  readonly fingerprints: Map<string, CacheFingerprint>;
  readonly checkpoints: Map<string, BaselineCheckpoint>;
  closing: boolean;
}

const productionFactories: ReviewSourceFactories = {
  openGit: (cwd, runner, signal) => GitRepository.open(cwd, runner, signal),
  createFilesystem: root => new FilesystemProject(root),
  watchGit: watchGitRepository,
};
const defaultCacheStore = createBaselineCacheStore();
const baselineCoordinators = new WeakMap<BaselineStore, BaselineCoordinator>();
const cacheTails = new Map<string, Promise<void>>();
const cacheGenerations = new Map<string, number>();
let runtimeCacheEnabled = true;
let sessionBaselines = new BaselineStore();
const sessionSources = new Map<string, ProjectReviewSource>();
const cacheStoreByRoot = new Map<string, BaselineCacheStore>();

function canonicalRoot(root: string): string {
  const absoluteRoot = resolve(root);
  return process.platform === "win32" ? absoluteRoot.toLowerCase() : absoluteRoot;
}

function coordinatorFor(baselines: BaselineStore): BaselineCoordinator {
  const existing = baselineCoordinators.get(baselines);
  if (existing !== undefined) return existing;

  const coordinator: BaselineCoordinator = {
    controller: new AbortController(),
    captures: new Map(),
    fingerprints: new Map(),
    checkpoints: new Map(),
    closing: false,
  };
  baselineCoordinators.set(baselines, coordinator);
  return coordinator;
}

function cacheGeneration(root: string): number {
  return cacheGenerations.get(canonicalRoot(root)) ?? 0;
}

function serializeCacheOperation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = canonicalRoot(root);
  const previous = cacheTails.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(() => undefined, () => undefined);
  cacheTails.set(key, settled);
  void settled.then(() => {
    if (cacheTails.get(key) === settled) cacheTails.delete(key);
  });
  return current;
}

function sameFingerprint(left: CacheFingerprint | undefined, right: CacheFingerprint): boolean {
  return left !== undefined && left.headOid === right.headOid &&
    left.indexFingerprint === right.indexFingerprint;
}

function cacheIdentity(
  root: string,
  headIdentity: string,
  fingerprint: CacheFingerprint,
): BaselineCacheIdentity | undefined {
  if (fingerprint.headOid === undefined || fingerprint.headOid.length === 0) return undefined;
  return {
    canonicalRoot: canonicalRoot(root),
    headIdentity,
    headOid: fingerprint.headOid,
    indexFingerprint: fingerprint.indexFingerprint,
  };
}


function waitForCaller<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolveWait, rejectWait) => {
    function cleanup(): void {
      signal.removeEventListener("abort", rejectAborted);
    }
    function rejectAborted(): void {
      cleanup();
      try {
        signal.throwIfAborted();
      } catch (error) {
        rejectWait(error);
      }
    }
    signal.addEventListener("abort", rejectAborted, { once: true });
    void shared.then(
      value => {
        cleanup();
        if (signal.aborted) {
          rejectAborted();
        } else {
          resolveWait(value);
        }
      },
      error => {
        cleanup();
        rejectWait(error);
      },
    );
  });
}

function sessionSummary(
  changes: ReadonlyMap<string, ChangeRecord>,
  summaryByPath: RepositoryInspection["summaryByPath"],
): ChangeSummary {
  let insertions = 0;
  let deletions = 0;
  for (const path of changes.keys()) {
    const summary = summaryByPath.get(normalizeProjectPath(path));
    if (summary === undefined) {
      throw new Error(`Git inspection omitted summary data for changed path: ${path}`);
    }
    insertions += summary.insertions;
    deletions += summary.deletions;
  }
  return { files: changes.size, insertions, deletions };
}

export class ProjectReviewSource implements ReviewSource {
  readonly #root: string;
  readonly #cacheStore: BaselineCacheStore | undefined;
  #backend: ActiveBackend | undefined;

  constructor(
    cwd: string,
    private readonly baselines: BaselineStore,
    private readonly runner?: ProcessRunner,
    private readonly factories: ReviewSourceFactories = productionFactories,
  ) {
    this.#root = resolve(cwd);
    this.#cacheStore = factories.cacheStore ??
      (factories === productionFactories ? defaultCacheStore : undefined);
  }

  #registerRepositoryRoot(root: string): void {
    if (this.baselines === sessionBaselines) {
      const key = canonicalRoot(root);
      sessionSources.set(key, this);
      if (this.#cacheStore !== undefined) cacheStoreByRoot.set(key, this.#cacheStore);
    }
  }

  async #discoverBackend(signal: AbortSignal): Promise<BackendDiscovery> {
    signal.throwIfAborted();
    const discoveredGit = await this.factories.openGit(this.#root, this.runner, signal);
    signal.throwIfAborted();

    if (discoveredGit === undefined) {
      const backend: ActiveBackend = this.#backend?.kind === "filesystem"
        ? this.#backend
        : {
          kind: "filesystem",
          root: this.#root,
          project: this.factories.createFilesystem(this.#root),
        };
      this.#backend = backend;
      return { backend };
    }

    const inspection = await discoveredGit.inspect(signal);
    signal.throwIfAborted();
    this.#registerRepositoryRoot(inspection.root);
    const backend: ActiveBackend = this.#backend?.kind === "git" &&
        canonicalRoot(this.#backend.root) === canonicalRoot(inspection.root)
      ? this.#backend
      : { kind: "git", root: inspection.root, project: discoveredGit };
    this.#backend = backend;
    return { backend, inspection };
  }

  #hashFile(
    repository: GitBackend,
    root: string,
  ): (absolutePath: string, signal: AbortSignal) => Promise<string | null> {
    return (absolutePath, signal) => {
      const projectPath = normalizeProjectPath(relative(root, absolutePath));
      return repository.contentHash(projectPath, signal);
    };
  }

  async #currentFingerprint(
    repository: GitBackend,
    signal: AbortSignal,
  ): Promise<CacheFingerprint | undefined> {
    try {
      const fingerprint = await repository.cacheFingerprint(signal);
      signal.throwIfAborted();
      if (fingerprint.indexFingerprint.length === 0) return undefined;
      return fingerprint;
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }

  async #persistCheckpoint(checkpoint: BaselineCheckpoint): Promise<void> {
    const identity = checkpoint.identity;
    const cacheStore = checkpoint.cacheStore;
    if (
      !runtimeCacheEnabled ||
      identity === undefined ||
      cacheStore === undefined ||
      checkpoint.generation !== cacheGeneration(checkpoint.root)
    ) return;
    const serialized = this.baselines.serialize(checkpoint.root, checkpoint.headIdentity);
    if (serialized === undefined) return;
    try {
      await serializeCacheOperation(checkpoint.root, async () => {
        if (
          !runtimeCacheEnabled ||
          checkpoint.generation !== cacheGeneration(checkpoint.root)
        ) return;
        await cacheStore.save(identity, serialized);
      });
    } catch {
    }
  }

  async #establishInspectedBaseline(
    repository: GitBackend,
    inspection: RepositoryInspection,
    callerSignal: AbortSignal,
  ): Promise<boolean> {
    callerSignal.throwIfAborted();
    const coordinator = coordinatorFor(this.baselines);
    coordinator.controller.signal.throwIfAborted();
    if (coordinator.closing) throw new DOMException("Review session ended", "AbortError");
    const key = `${canonicalRoot(inspection.root)}\0${inspection.headIdentity}`;

    for (;;) {
      callerSignal.throwIfAborted();
      const fingerprint = await this.#currentFingerprint(repository, callerSignal);
      if (coordinator.closing) throw new DOMException("Review session ended", "AbortError");
      const baseline = this.baselines.get(inspection.root, inspection.headIdentity);
      const previousFingerprint = coordinator.fingerprints.get(key);
      if (baseline !== undefined) {
        if (fingerprint === undefined || previousFingerprint === undefined) return false;
        if (sameFingerprint(previousFingerprint, fingerprint)) return false;
        if (previousFingerprint.headOid === fingerprint.headOid) {
          coordinator.fingerprints.set(key, fingerprint);
          coordinator.checkpoints.delete(key);
          if (this.#cacheStore !== undefined) {
            await clearProjectBaselineCache(inspection.root);
          }
          return false;
        }
      }

      const existing = coordinator.captures.get(key);
      if (existing !== undefined) {
        await waitForCaller(existing, callerSignal);
        continue;
      }

      const generation = cacheGeneration(inspection.root);
      const identity = fingerprint === undefined
        ? undefined
        : cacheIdentity(inspection.root, inspection.headIdentity, fingerprint);
      const cacheStore = this.#cacheStore;
      const capture = (async (): Promise<boolean> => {
        if (coordinator.closing) throw new DOMException("Review session ended", "AbortError");
        if (
          runtimeCacheEnabled &&
          cacheStore !== undefined &&
          identity !== undefined &&
          generation === cacheGeneration(inspection.root)
        ) {
          try {
            const cached = await serializeCacheOperation(inspection.root, () =>
              runtimeCacheEnabled && generation === cacheGeneration(inspection.root)
                ? cacheStore.load(identity)
                : Promise.resolve(undefined));
            coordinator.controller.signal.throwIfAborted();
            const confirmedFingerprint = cached === undefined
              ? undefined
              : await this.#currentFingerprint(repository, coordinator.controller.signal);
            if (
              runtimeCacheEnabled &&
              generation === cacheGeneration(inspection.root) &&
              cached !== undefined &&
              confirmedFingerprint !== undefined &&
              sameFingerprint(fingerprint, confirmedFingerprint) &&
              canonicalRoot(cached.root) === canonicalRoot(inspection.root) &&
              cached.headIdentity === inspection.headIdentity &&
              this.baselines.hydrate(cached)
            ) {
              coordinator.fingerprints.set(key, fingerprint!);
              coordinator.checkpoints.set(key, {
                root: inspection.root,
                headIdentity: inspection.headIdentity,
                identity,
                cacheStore,
                generation,
              });
              return false;
            }
          } catch {
            coordinator.controller.signal.throwIfAborted();
          }
        }

        await this.baselines.capture(
          inspection.root,
          inspection.headIdentity,
          inspection.changes,
          this.#hashFile(repository, inspection.root),
          coordinator.controller.signal,
        );
        coordinator.controller.signal.throwIfAborted();
        if (coordinator.closing) return true;
        const confirmedFingerprint = await this.#currentFingerprint(
          repository,
          coordinator.controller.signal,
        );
        coordinator.fingerprints.set(key, fingerprint ?? { indexFingerprint: "" });
        if (confirmedFingerprint === undefined || !sameFingerprint(fingerprint, confirmedFingerprint)) return true;
        const checkpoint: BaselineCheckpoint = {
          root: inspection.root,
          headIdentity: inspection.headIdentity,
          ...(identity === undefined ? {} : { identity }),
          ...(cacheStore === undefined ? {} : { cacheStore }),
          generation,
        };
        coordinator.checkpoints.set(key, checkpoint);
        if (runtimeCacheEnabled) await this.#persistCheckpoint(checkpoint);
        return true;
      })();
      coordinator.captures.set(key, capture);
      void capture.then(
        () => {
          if (coordinator.captures.get(key) === capture) coordinator.captures.delete(key);
        },
        () => {
          if (coordinator.captures.get(key) === capture) coordinator.captures.delete(key);
        },
      );
      return await waitForCaller(capture, callerSignal);
    }
  }

  async establishBaseline(signal: AbortSignal): Promise<void> {
    const discovery = await this.#discoverBackend(signal);
    if (discovery.backend.kind === "filesystem") return;
    if (discovery.inspection === undefined) {
      throw new Error("Git backend discovery did not produce a repository inspection");
    }
    await this.#establishInspectedBaseline(
      discovery.backend.project,
      discovery.inspection,
      signal,
    );
  }

  async #gitBackend(signal: AbortSignal): Promise<Extract<ActiveBackend, { kind: "git" }>> {
    signal.throwIfAborted();
    const backend = this.#backend ?? (await this.#discoverBackend(signal)).backend;
    if (backend.kind !== "git") {
      throw new Error("Git-only review operations require a Git repository");
    }
    return backend;
  }

  async refresh(options: RefreshOptions): Promise<ProjectSnapshot> {
    const discovery = await this.#discoverBackend(options.signal);
    if (discovery.backend.kind === "filesystem") {
      const inspection = await discovery.backend.project.inspect(options.signal);
      options.signal.throwIfAborted();
      return {
        kind: "filesystem",
        root: discovery.backend.root,
        hasHead: false,
        allFiles: inspection.allFiles,
        workspaceChanges: new Map(),
        sessionChanges: new Map(),
        workspaceSummary: emptySummary(),
        workspaceSummaryByPath: new Map(),
        sessionSummary: emptySummary(),
        truncated: inspection.truncated,
      };
    }
    if (discovery.inspection === undefined) {
      throw new Error("Git backend discovery did not produce a repository inspection");
    }

    const inspection = discovery.inspection;
    const established = await this.#establishInspectedBaseline(
      discovery.backend.project,
      inspection,
      options.signal,
    );
    const sessionChanges = established
      ? new Map<string, ChangeRecord>()
      : await this.baselines.compare(
        inspection.root,
        inspection.headIdentity,
        inspection.changes,
        this.#hashFile(discovery.backend.project, inspection.root),
        options.signal,
      );
    const baseline = this.baselines.get(inspection.root, inspection.headIdentity);
    if (baseline === undefined) {
      throw new Error(`Session baseline was not established for repository: ${inspection.root}`);
    }

    return {
      kind: "git",
      root: inspection.root,
      hasHead: inspection.hasHead,
      ...(inspection.currentBranch !== undefined ? { currentBranch: inspection.currentBranch } : {}),
      ...(inspection.detachedAt !== undefined ? { detachedAt: inspection.detachedAt } : {}),
      allFiles: inspection.allFiles,
      workspaceChanges: inspection.changes,
      sessionChanges,
      mtimeByPath: inspection.mtimeByPath,
      workspaceSummary: inspection.summary,
      workspaceSummaryByPath: inspection.summaryByPath,
      sessionSummary: sessionSummary(sessionChanges, inspection.summaryByPath),
      baselineEstablishedAt: baseline.establishedAt,
      truncated: false,
    };
  }

  async preview(path: string, options: PreviewOptions): Promise<FilePreview> {
    const backend = this.#backend ?? (await this.#discoverBackend(options.signal)).backend;
    if (backend.kind === "filesystem") {
      return backend.project.preview(path, options.signal);
    }
    if (options.mode === "content") {
      return this.factories.createFilesystem(backend.root).preview(path, options.signal);
    }
    return backend.project.preview(path, options.signal, options.diffContext);
  }

  async history(options: RefreshOptions): Promise<GitLogSnapshot> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.history(options.signal);
  }

  async commitDiff(oid: string, options: PreviewOptions): Promise<CommitDiffPreview> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.commitDiff(oid, options.signal, options.diffContext);
  }

  async branches(options: RefreshOptions): Promise<GitBranchSnapshot> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.branches(options.signal);
  }

  async switchBranch(name: string, options: SwitchBranchOptions): Promise<void> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.switchBranch(name, options);
  }

  async watch(options: WatchOptions): Promise<void> {
    const backend = await this.#gitBackend(options.signal);
    return (this.factories.watchGit ?? watchGitRepository)(backend.root, options);
  }

  async headMessage(options: RefreshOptions): Promise<HeadMessage | undefined> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.headMessage(options.signal);
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.commit(options);
  }

  async amend(options: AmendOptions): Promise<AmendResult> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.amend(options);
  }

  async pushPlan(options: RefreshOptions): Promise<PushPlan> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.pushPlan(options);
  }

  async push(options: PushOptions): Promise<PushResult> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.push(options);
  }

  async revert(options: RevertOptions): Promise<RevertResult> {
    const backend = await this.#gitBackend(options.signal);
    return backend.project.revert(options);
  }
}

function sourceFor(
  cwd: string,
  runner: ProcessRunner | undefined,
  factories: ReviewSourceFactories,
): ProjectReviewSource {
  const key = canonicalRoot(cwd);
  const existing = sessionSources.get(key);
  if (existing !== undefined) return existing;

  const source = new ProjectReviewSource(cwd, sessionBaselines, runner, factories);
  sessionSources.set(key, source);
  const cacheStore = factories.cacheStore ??
    (factories === productionFactories ? defaultCacheStore : undefined);
  if (cacheStore !== undefined) cacheStoreByRoot.set(key, cacheStore);
  return source;
}

/** Set whether the active session may read or write persistent baselines. */
export function setSessionBaselineCacheEnabled(enabled: boolean): void {
  runtimeCacheEnabled = enabled;
}

/** Remove one project's persistent baseline cache, invalidating queued writes. */
export async function clearProjectBaselineCache(cwd: string): Promise<void> {
  let root = resolve(cwd);
  try {
    const repository = await GitRepository.open(cwd);
    if (repository !== undefined) {
      const inspection = await repository.inspect(new AbortController().signal);
      root = inspection.root;
    }
  } catch {
  }
  const key = canonicalRoot(root);
  cacheGenerations.set(key, cacheGeneration(root) + 1);
  const store = cacheStoreByRoot.get(key) ?? defaultCacheStore;
  try {
    await serializeCacheOperation(root, () => store.clearForRoot(root));
  } catch {
  }
}

export function createReviewSource(cwd: string): ReviewSource;
export function createReviewSource(cwd: string, cacheEnabled: boolean): ReviewSource;
export function createReviewSource(
  cwd: string,
  runner: ProcessRunner | undefined,
  factories: ReviewSourceFactories,
  cacheEnabled?: boolean,
): ReviewSource;
export function createReviewSource(
  cwd: string,
  runnerOrCacheEnabled?: ProcessRunner | boolean,
  factories: ReviewSourceFactories = productionFactories,
  cacheEnabled?: boolean,
): ReviewSource {
  const runner = typeof runnerOrCacheEnabled === "boolean" ? undefined : runnerOrCacheEnabled;
  const enabled = typeof runnerOrCacheEnabled === "boolean"
    ? runnerOrCacheEnabled
    : cacheEnabled;
  if (enabled !== undefined) setSessionBaselineCacheEnabled(enabled);
  return sourceFor(cwd, runner, factories);
}

export function prepareSessionBaseline(cwd: string): Promise<void>;
export function prepareSessionBaseline(cwd: string, cacheEnabled: boolean): Promise<void>;
export function prepareSessionBaseline(
  cwd: string,
  runner: ProcessRunner | undefined,
  factories: ReviewSourceFactories,
  cacheEnabled?: boolean,
): Promise<void>;
export async function prepareSessionBaseline(
  cwd: string,
  runnerOrCacheEnabled?: ProcessRunner | boolean,
  factories: ReviewSourceFactories = productionFactories,
  cacheEnabled?: boolean,
): Promise<void> {
  const runner = typeof runnerOrCacheEnabled === "boolean" ? undefined : runnerOrCacheEnabled;
  const enabled = typeof runnerOrCacheEnabled === "boolean"
    ? runnerOrCacheEnabled
    : cacheEnabled;
  if (enabled !== undefined) setSessionBaselineCacheEnabled(enabled);
  await sourceFor(cwd, runner, factories).establishBaseline(
    new AbortController().signal,
  );
}

/** Persist active baseline checkpoints and isolate subsequent session state. */
export async function clearSessionBaselines(cacheEnabled = runtimeCacheEnabled): Promise<void> {
  runtimeCacheEnabled = cacheEnabled;
  const previousCoordinator = coordinatorFor(sessionBaselines);
  previousCoordinator.closing = true;
  if (cacheEnabled) {
    await Promise.all([...previousCoordinator.checkpoints.values()].map(async checkpoint => {
      const identity = checkpoint.identity;
      const cacheStore = checkpoint.cacheStore;
      const serialized = sessionBaselines.serialize(checkpoint.root, checkpoint.headIdentity);
      if (serialized === undefined || identity === undefined || cacheStore === undefined) return;
      try {
        await serializeCacheOperation(checkpoint.root, async () => {
          if (cacheEnabled && checkpoint.generation === cacheGeneration(checkpoint.root)) {
            await cacheStore.save(identity, serialized);
          }
        });
      } catch {
      }
    }));
  }
  previousCoordinator.controller.abort(
    new DOMException("Review session ended", "AbortError"),
  );
  while (cacheTails.size > 0) await Promise.all([...cacheTails.values()]);
  sessionBaselines = new BaselineStore();
  coordinatorFor(sessionBaselines);
  sessionSources.clear();
  cacheStoreByRoot.clear();
}
