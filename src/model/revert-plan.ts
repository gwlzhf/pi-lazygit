import {
  isRevertible,
  normalizeProjectPath,
  type ChangeRecord,
  type RevertPlan,
} from "../contracts";

function comparePaths(left: string, right: string): number {
  const folded = left.toLowerCase().localeCompare(right.toLowerCase());
  return folded || left.localeCompare(right);
}

function sorted(paths: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(paths)].sort(comparePaths));
}

/**
 * Splits changed paths into the buckets a revert handles.
 *
 * The buckets are distinct because Git treats them distinctly, and the plan
 * drives both what the confirmation describes and what the commands do. It is
 * derived from a snapshot, so the repository resolves the same paths afresh
 * before writing: a path committed or reverted since is simply skipped.
 *
 * A rename contributes both names — HEAD still holds the old one, and the new
 * one is only in the index. Unmerged paths are dropped, because Git cannot
 * restore a side of a conflict the user never chose.
 */
export function revertPlan(
  selected: ReadonlyMap<string, ChangeRecord>,
): RevertPlan {
  const restore = new Set<string>();
  const unindex = new Set<string>();
  const remove = new Set<string>();

  for (const record of selected.values()) {
    if (!isRevertible(record)) continue;
    const path = normalizeProjectPath(record.path);
    // Porcelain reports the index column as `A` only for a path HEAD does not
    // hold, so such a path has to leave the index instead of being restored.
    if (record.status === "?") {
      remove.add(path);
    } else if (record.index === "A") {
      unindex.add(path);
      remove.add(path);
    } else if (record.status === "R" && record.oldPath !== undefined) {
      restore.add(normalizeProjectPath(record.oldPath));
      unindex.add(path);
      remove.add(path);
    } else {
      restore.add(path);
    }
  }

  return {
    restore: sorted(restore),
    unindex: sorted(unindex),
    remove: sorted(remove),
    paths: sorted([...restore, ...unindex, ...remove]),
  };
}

/** What a confirmation has to say, with the buckets' overlap already resolved. */
export interface RevertSummary {
  /** Distinct paths the plan covers, however each one is handled. */
  readonly total: number;
  /** Paths that exist in the working tree and will be put back. */
  readonly discarded: readonly string[];
  /** Files Git has to delete, because it never tracked them. */
  readonly deleted: readonly string[];
}

/**
 * Reduces a plan to the numbers and names a confirmation shows.
 *
 * `remove` deliberately overlaps `unindex`: an addition has to leave the index
 * *and* be deleted. Counting the buckets directly would count that path twice
 * and describe a staged addition as an untracked file, so the overlap is
 * resolved here, where the invariant lives.
 */
export function summarizeRevert(plan: RevertPlan): RevertSummary {
  const unindexed = new Set(plan.unindex);
  const deleted = plan.remove.filter(path => !unindexed.has(path));
  const deletedSet = new Set(deleted);
  return {
    total: plan.paths.length,
    discarded: plan.paths.filter(path => !deletedSet.has(path)),
    deleted,
  };
}