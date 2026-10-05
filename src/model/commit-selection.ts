import type { ChangeRecord, ChangeScope } from "../contracts";
import { isCommittable } from "../contracts";

/** Tracks the paths selected for a path-limited commit. */
export class CommitSelection {
  readonly #selected = new Set<string>();
  readonly #known = new Set<string>();
  readonly #uncommittable = new Set<string>();

  /** Initialize paths; only committable tracked changes default to selected. */
  initialize(records: Iterable<ChangeRecord>): void {
    const next = new Map<string, boolean>();
    for (const record of records) {
      const committable = isCommittable(record);
      next.set(record.path, committable);
      if (committable && record.status !== "?" && !this.#known.has(record.path)) {
        this.#selected.add(record.path);
      }
    }
    for (const [path, committable] of next) {
      if (!committable) this.#selected.delete(path);
    }
    this.#known.clear();
    this.#uncommittable.clear();
    for (const [path, committable] of next) {
      this.#known.add(path);
      if (!committable) this.#uncommittable.add(path);
    }
  }

  /** Toggle one path and return its new selected state. */
  toggle(path: string): boolean {
    if (this.#uncommittable.has(path)) return false;
    if (this.#selected.has(path)) {
      this.#selected.delete(path);
      return false;
    }
    this.#selected.add(path);
    return true;
  }

  /** Invert one path and return its new selected state. */
  invert(path: string): boolean {
    return this.toggle(path);
  }

  /** Select every supplied path. */
  selectAll(paths: Iterable<string>): void {
    for (const path of paths) {
      if (!this.#uncommittable.has(path)) this.#selected.add(path);
    }
  }

  /** Clear every selected path. */
  clear(): void {
    this.#selected.clear();
  }

  /** Remove paths that are no longer available in the active change set. */
  prune(availablePaths: Iterable<string>): void {
    const available = new Set(availablePaths);
    for (const path of this.#selected) {
      if (!available.has(path)) this.#selected.delete(path);
    }
    for (const path of this.#known) {
      if (!available.has(path)) this.#known.delete(path);
    }
    for (const path of this.#uncommittable) {
      if (!available.has(path)) this.#uncommittable.delete(path);
    }
  }

  /** Reset selection after a commit, selecting remaining committable tracked paths. */
  reset(records: Iterable<ChangeRecord>): void {
    this.#selected.clear();
    this.#known.clear();
    this.#uncommittable.clear();
    this.initialize(records);
  }

  /** Whether a project path is selected. */
  has(path: string): boolean {
    return this.#selected.has(path);
  }

  /** Number of selected paths. */
  get size(): number {
    return this.#selected.size;
  }

  /** Return an isolated read-only view of the current selected paths. */
  selectedPaths(): ReadonlySet<string> {
    return new Set(this.#selected);
  }
}

/** Whether a selection may be submitted by a path-limited commit. */
export function canCommit(scope: ChangeScope, selectedCount: number): boolean {
  return scope === "workspace" && selectedCount > 0;
}
