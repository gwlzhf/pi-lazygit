import { join, resolve } from "node:path";
import type {
  BaselineEntry,
  ChangeRecord,
  RepositoryBaseline,
} from "../contracts";
import { normalizeProjectPath } from "../contracts";
export interface SerializedBaseline {
  readonly root: string;
  readonly headIdentity: string;
  readonly establishedAt: number;
  readonly entries: readonly {
    readonly path: string;
    readonly status: BaselineEntry["status"];
    readonly hash: string | null;
  }[];
}
const BASELINE_STATUS_CODES: Readonly<Record<BaselineEntry["status"], true>> = {
  M: true,
  A: true,
  D: true,
  R: true,
  "?": true,
  U: true,
};

/** Validate a serialized baseline before hydration or persistent storage. */
export function isSerializedBaseline(value: unknown): value is SerializedBaseline {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.root !== "string" ||
    candidate.root.length === 0 ||
    typeof candidate.headIdentity !== "string" ||
    candidate.headIdentity.length === 0 ||
    typeof candidate.establishedAt !== "number" ||
    !Number.isFinite(candidate.establishedAt) ||
    !Array.isArray(candidate.entries)
  ) return false;

  const paths = new Set<string>();
  for (const entry of candidate.entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const candidateEntry = entry as Record<string, unknown>;
    if (
      typeof candidateEntry.path !== "string" ||
      typeof candidateEntry.status !== "string" ||
      !Object.hasOwn(BASELINE_STATUS_CODES, candidateEntry.status) ||
      (typeof candidateEntry.hash !== "string" && candidateEntry.hash !== null)
    ) return false;
    try {
      const path = normalizeBaselinePath(candidateEntry.path);
      if (path !== candidateEntry.path || paths.has(path)) return false;
      paths.add(path);
    } catch {
      return false;
    }
  }
  return true;
}

function freezeBaseline(value: SerializedBaseline): RepositoryBaseline {
  const entries = new Map<string, BaselineEntry>();
  for (const entry of value.entries) {
    entries.set(entry.path, Object.freeze({ status: entry.status, hash: entry.hash }));
  }
  return Object.freeze({
    root: value.root,
    headIdentity: value.headIdentity,
    establishedAt: value.establishedAt,
    entries,
  });
}
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

function baselineKey(root: string, headIdentity: string): string {
  return `${canonicalRoot(root)}\0${headIdentity}`;
}

export class BaselineStore {
  readonly #baselines = new Map<string, RepositoryBaseline>();

  async capture(
    root: string,
    headIdentity: string,
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
      headIdentity,
      establishedAt: now,
      entries,
    });
    this.#baselines.set(baselineKey(root, headIdentity), baseline);
    return baseline;
  }

  /** Serialize one in-memory baseline to a JSON-safe immutable value. */
  serialize(root: string, headIdentity: string): SerializedBaseline | undefined {
    const baseline = this.get(root, headIdentity);
    if (baseline === undefined) return undefined;
    return Object.freeze({
      root: baseline.root,
      headIdentity: baseline.headIdentity,
      establishedAt: baseline.establishedAt,
      entries: Object.freeze([...baseline.entries].map(([path, entry]) =>
        Object.freeze({ path, status: entry.status, hash: entry.hash })
      )),
    });
  }

  /** Hydrate one validated serialized baseline into the authoritative memory map. */
  hydrate(value: unknown): boolean {
    if (!isSerializedBaseline(value)) return false;
    const baseline = freezeBaseline(value);
    this.#baselines.set(baselineKey(baseline.root, baseline.headIdentity), baseline);
    return true;
  }

  get(root: string, headIdentity: string): RepositoryBaseline | undefined {
    return this.#baselines.get(baselineKey(root, headIdentity));
  }

  async compare(
    root: string,
    headIdentity: string,
    current: ReadonlyMap<string, ChangeRecord>,
    hashFile: HashFile,
    signal: AbortSignal,
  ): Promise<Map<string, ChangeRecord>> {
    signal.throwIfAborted();
    const baseline = this.get(root, headIdentity);
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
