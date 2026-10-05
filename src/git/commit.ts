import {
  isCommittable,
  normalizeProjectPath,
  type ChangeRecord,
} from "../contracts";

/**
 * Windows caps a command line at roughly 32K characters, and every extra path
 * costs its own length plus a separator, so staging runs in batches.
 */
export const PATH_BATCH_SIZE = 200;

/** How a selection of changed paths maps onto the commands that record it. */
export interface CommitPlan {
  /** Untracked paths, staged without `-A` so nothing else is swept in. */
  readonly untracked: readonly string[];
  /** Tracked paths, staged with `-A` so deletions are recorded too. */
  readonly tracked: readonly string[];
  /**
   * Every path the commit may touch. A rename contributes both names, otherwise
   * `git commit -- <new>` records a delete plus an add instead of a rename.
   */
  readonly paths: readonly string[];
}

function comparePaths(left: string, right: string): number {
  const folded = left.toLowerCase().localeCompare(right.toLowerCase());
  return folded || left.localeCompare(right);
}

/**
 * Splits a selection into the batches the panel may commit. Unmerged paths are
 * dropped: `git commit -- <path>` refuses them, so offering them would only
 * produce a failure the user cannot act on.
 */
export function planCommit(
  selected: ReadonlyMap<string, ChangeRecord>,
): CommitPlan {
  const untracked: string[] = [];
  const tracked: string[] = [];
  const paths = new Set<string>();

  for (const record of selected.values()) {
    if (!isCommittable(record)) continue;
    const path = normalizeProjectPath(record.path);
    paths.add(path);
    if (record.oldPath !== undefined) paths.add(normalizeProjectPath(record.oldPath));
    if (record.status === "?") untracked.push(path);
    else tracked.push(path);
  }

  return {
    untracked: [...untracked].sort(comparePaths),
    tracked: [...tracked].sort(comparePaths),
    paths: [...paths].sort(comparePaths),
  };
}

function batched(paths: readonly string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < paths.length; index += size) {
    batches.push(paths.slice(index, index + size));
  }
  return batches;
}

export interface CommitInvocation {
  readonly argv: readonly string[];
}

/**
 * The `git add` calls that record `plan` in the index. `-A` is used for tracked
 * paths because a path removed from the working tree is a change Git only
 * records when deletions are staged explicitly.
 */
export function stageInvocations(plan: CommitPlan): readonly CommitInvocation[] {
  const invocations: CommitInvocation[] = [];
  for (const batch of batched(plan.tracked, PATH_BATCH_SIZE)) {
    invocations.push({ argv: ["--literal-pathspecs", "add", "-A", "--", ...batch] });
  }
  for (const batch of batched(plan.untracked, PATH_BATCH_SIZE)) {
    invocations.push({ argv: ["--literal-pathspecs", "add", "--", ...batch] });
  }
  return Object.freeze(invocations);
}

export interface CommitArgvOptions {
  readonly dryRun?: boolean;
  readonly noVerify?: boolean;
}

/**
 * The `git commit` invocation for a path-limited commit. `--all` is never used:
 * the path list is the fence that keeps an unrelated staged file out of the
 * commit, and `-a` would discard it.
 */
export function commitArgv(
  message: string,
  paths: readonly string[],
  options: CommitArgvOptions = {},
): readonly string[] {
  const argv = ["--literal-pathspecs", "commit"];
  if (options.dryRun === true) argv.push("--dry-run");
  if (options.noVerify === true) argv.push("--no-verify");
  argv.push("-m", message, "--", ...paths);
  return Object.freeze(argv);
}

export interface AmendArgvOptions {
  readonly noVerify?: boolean;
}

/**
 * The `git commit --amend` invocation that replaces only the subject. The body
 * is replayed through a second `-m`, because a single `-m` discards it.
 */
export function amendArgv(
  subject: string,
  body: string | undefined,
  options: AmendArgvOptions = {},
): readonly string[] {
  const argv = ["--literal-pathspecs", "commit", "--amend", "--allow-empty", "--cleanup=verbatim"];
  if (options.noVerify === true) argv.push("--no-verify");
  argv.push("-m", subject);
  if (body !== undefined && body.length > 0) argv.push("-m", body);
  return Object.freeze(argv);
}

/** Rejects a commit message Git would refuse, before anything is staged. */
export function assertCommitMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new TypeError("A commit message must not be empty");
  }
  return trimmed;
}