import { join, resolve } from "node:path";
import type {
  BaselineEntry,
  ChangeRecord,
  RepositoryBaseline,
} from "../contracts";
import { normalizeProjectPath } from "../contracts";

export type HashFile = (
  absolutePath: string,
  signal: AbortSignal,
) => Promise<string | null>;

function canonicalRoot(root: string): string {
  const absoluteRoot = resolve(root);
  return process.platform === "win32" ? absoluteRoot.toLowerCase() : absoluteRoot;
}

function normalizeBaselinePath(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:(?:\/|$)/.test(normalized)
  ) {
    throw new TypeError(`Project path must be non-empty and relative: ${path}`);
  }

  const segments = normalized.split("/");
  if (segments.includes("..")) {
    throw new TypeError(`Project path must not traverse its parent: ${path}`);
  }

  const compact = segments.filter((segment) => segment.length > 0 && segment !== ".");
  if (compact.length === 0) {
    throw new TypeError(`Project path must identify a file: ${path}`);
  }
  return compact.join("/");
}

function absoluteProjectPath(root: string, projectPath: string): string {
  return join(resolve(root), ...projectPath.split("/"));
}

export class BaselineStore {
  readonly #baselines = new Map<string, RepositoryBaseline>();

  async capture(
    root: string,
    changes: ReadonlyMap<string, ChangeRecord>,
    hashFile: HashFile,
    signal: AbortSignal,
    now: number = Date.now(),
  ): Promise<RepositoryBaseline> {
    signal.throwIfAborted();
    const entries = new Map<string, BaselineEntry>();

    for (const record of changes.values()) {
      signal.throwIfAborted();
      const projectPath = normalizeBaselinePath(record.path);
      let hash: string | null = null;
      if (record.status !== "D") {
        hash = await hashFile(absoluteProjectPath(root, projectPath), signal);
        signal.throwIfAborted();
      }
      entries.set(projectPath, Object.freeze({ status: record.status, hash }));
    }

    signal.throwIfAborted();
    const baseline: RepositoryBaseline = Object.freeze({
      root,
      establishedAt: now,
      entries,
    });
    this.#baselines.set(canonicalRoot(root), baseline);
    return baseline;
  }

  get(root: string): RepositoryBaseline | undefined {
    return this.#baselines.get(canonicalRoot(root));
  }

  async compare(
    root: string,
    current: ReadonlyMap<string, ChangeRecord>,
    hashFile: HashFile,
    signal: AbortSignal,
  ): Promise<Map<string, ChangeRecord>> {
    signal.throwIfAborted();
    const baseline = this.get(root);
    const result = new Map<string, ChangeRecord>();

    for (const record of current.values()) {
      signal.throwIfAborted();
      const projectPath = normalizeBaselinePath(record.path);
      const normalizedRecord = projectPath === record.path
        ? record
        : { ...record, path: projectPath };
      const entry = baseline?.entries.get(projectPath);
      if (entry === undefined || entry.status !== record.status) {
        result.set(projectPath, normalizedRecord);
        continue;
      }

      let currentHash: string | null = null;
      if (record.status !== "D") {
        currentHash = await hashFile(absoluteProjectPath(root, projectPath), signal);
        signal.throwIfAborted();
      }
      if (currentHash !== entry.hash) result.set(projectPath, normalizedRecord);
    }

    signal.throwIfAborted();
    return result;
  }

  clear(): void {
    this.#baselines.clear();
  }
}
