import { relative, resolve } from "node:path";
import {
  emptySummary,
  normalizeProjectPath,
  type ChangeRecord,
  type ChangeSummary,
  type FilePreview,
  type PreviewOptions,
  type ProjectSnapshot,
  type RefreshOptions,
  type ReviewSource,
} from "./contracts";
import { FilesystemProject } from "./filesystem";
import { GitRepository, type RepositoryInspection } from "./git/repository";
import type { ProcessRunner } from "./git/process";
import { BaselineStore } from "./model/baseline";

type GitBackend = Pick<GitRepository, "inspect" | "contentHash" | "preview">;
type FilesystemBackend = Pick<FilesystemProject, "inspect" | "preview">;

export interface ReviewSourceFactories {
  readonly openGit: (
    cwd: string,
    runner: ProcessRunner | undefined,
    signal: AbortSignal,
  ) => Promise<GitBackend | undefined>;
  readonly createFilesystem: (root: string) => FilesystemBackend;
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

interface BaselineCoordinator {
  readonly controller: AbortController;
  readonly captures: Map<string, Promise<void>>;
}

const productionFactories: ReviewSourceFactories = {
  openGit: (cwd, runner, signal) => GitRepository.open(cwd, runner, signal),
  createFilesystem: root => new FilesystemProject(root),
};
const baselineCoordinators = new WeakMap<BaselineStore, BaselineCoordinator>();
let sessionBaselines = new BaselineStore();
const sessionSources = new Map<string, ProjectReviewSource>();

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
  };
  baselineCoordinators.set(baselines, coordinator);
  return coordinator;
}

function waitForCaller(shared: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolveWait, rejectWait) => {
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
      () => {
        cleanup();
        if (signal.aborted) {
          rejectAborted();
        } else {
          resolveWait();
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
  #backend: ActiveBackend | undefined;

  constructor(
    cwd: string,
    private readonly baselines: BaselineStore,
    private readonly runner?: ProcessRunner,
    private readonly factories: ReviewSourceFactories = productionFactories,
  ) {
    this.#root = resolve(cwd);
  }

  #registerRepositoryRoot(root: string): void {
    if (this.baselines === sessionBaselines) {
      sessionSources.set(canonicalRoot(root), this);
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

  async #establishInspectedBaseline(
    repository: GitBackend,
    inspection: RepositoryInspection,
    callerSignal: AbortSignal,
  ): Promise<boolean> {
    callerSignal.throwIfAborted();
    if (this.baselines.get(inspection.root) !== undefined) return false;

    const coordinator = coordinatorFor(this.baselines);
    coordinator.controller.signal.throwIfAborted();
    const key = canonicalRoot(inspection.root);
    let capture = coordinator.captures.get(key);
    if (capture === undefined) {
      const hashFile = this.#hashFile(repository, inspection.root);
      capture = this.baselines
        .capture(
          inspection.root,
          inspection.changes,
          hashFile,
          coordinator.controller.signal,
        )
        .then(() => undefined);
      coordinator.captures.set(key, capture);
      const completedCapture = capture;
      void capture.then(
        () => {
          if (coordinator.captures.get(key) === completedCapture) {
            coordinator.captures.delete(key);
          }
        },
        () => {
          if (coordinator.captures.get(key) === completedCapture) {
            coordinator.captures.delete(key);
          }
        },
      );
    }

    await waitForCaller(capture, callerSignal);
    callerSignal.throwIfAborted();
    return true;
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
        inspection.changes,
        this.#hashFile(discovery.backend.project, inspection.root),
        options.signal,
      );
    const baseline = this.baselines.get(inspection.root);
    if (baseline === undefined) {
      throw new Error(`Session baseline was not established for repository: ${inspection.root}`);
    }

    return {
      kind: "git",
      root: inspection.root,
      hasHead: inspection.hasHead,
      allFiles: inspection.allFiles,
      workspaceChanges: inspection.changes,
      sessionChanges,
      workspaceSummary: inspection.summary,
      sessionSummary: sessionSummary(sessionChanges, inspection.summaryByPath),
      baselineEstablishedAt: baseline.establishedAt,
      truncated: false,
    };
  }

  async preview(path: string, options: PreviewOptions): Promise<FilePreview> {
    const backend = this.#backend ?? (await this.#discoverBackend(options.signal)).backend;
    return backend.project.preview(path, options.signal);
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
  return source;
}

export function createReviewSource(cwd: string): ReviewSource;
export function createReviewSource(
  cwd: string,
  runner: ProcessRunner | undefined,
  factories: ReviewSourceFactories,
): ReviewSource;
export function createReviewSource(
  cwd: string,
  runner?: ProcessRunner,
  factories: ReviewSourceFactories = productionFactories,
): ReviewSource {
  return sourceFor(cwd, runner, factories);
}

export function prepareSessionBaseline(cwd: string): Promise<void>;
export function prepareSessionBaseline(
  cwd: string,
  runner: ProcessRunner | undefined,
  factories: ReviewSourceFactories,
): Promise<void>;
export async function prepareSessionBaseline(
  cwd: string,
  runner?: ProcessRunner,
  factories: ReviewSourceFactories = productionFactories,
): Promise<void> {
  await sourceFor(cwd, runner, factories).establishBaseline(
    new AbortController().signal,
  );
}

export function clearSessionBaselines(): void {
  const previousCoordinator = coordinatorFor(sessionBaselines);
  previousCoordinator.controller.abort(
    new DOMException("Review session ended", "AbortError"),
  );
  sessionBaselines = new BaselineStore();
  coordinatorFor(sessionBaselines);
  sessionSources.clear();
}
