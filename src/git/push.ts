/**
 * Environment that makes Git fail fast instead of blocking on a credential
 * prompt. The panel has no terminal to hand over, so an interactive prompt
 * would hang until the push is abandoned.
 */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
});

/** Commits listed for the push confirmation; longer lists are truncated. */
export const MAX_PUSH_PLAN_COMMITS = 200;

/** A push can block on the network far longer than a local command can. */
export const DEFAULT_PUSH_TIMEOUT_MS = 120_000;

export interface UpstreamRef {
  /** Resolved by Git, so a slash inside either half is never guessed at. */
  readonly remote: string;
  /** The remote-tracking ref, such as `refs/remotes/origin/main`. */
  readonly trackingRef: string;
}

/**
 * Parses the `%(upstream:remotename)` and `%(upstream:remoteref)` pair Git
 * reports for a branch. The `@{u}` shorthand cannot be split by hand because a
 * slash is legal inside both the remote name and the branch name.
 */
export function parseUpstreamFields(text: string, branch?: string): UpstreamRef | undefined {
  const records = text.trim().split(/\r?\n/u);
  for (const record of records) {
    const fields = record.split("\0");
    const ref = fields[0]?.trim() ?? "";
    if (branch !== undefined && ref !== `refs/heads/${branch}`) continue;
    const offset = branch === undefined ? 0 : 1;
    const remote = fields[offset]?.trim() ?? "";
    const trackingRef = fields[offset + 1]?.trim() ?? "";
    if (remote.length > 0 && trackingRef.length > 0) {
      return Object.freeze({ remote, trackingRef });
    }
  }
  return undefined;
}

export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

function parseCount(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new TypeError(`Malformed ahead/behind count: ${label} is not a number`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`Malformed ahead/behind count: ${label} exceeds the safe integer range`);
  }
  return parsed;
}

/**
 * Parses `git rev-list --left-right --count <upstream>...HEAD`, which prints
 * the commits only the upstream has and then the commits only HEAD has.
 */
export function parseAheadBehind(stdout: string): AheadBehind {
  const line = stdout.trim();
  const [left, right] = line.split(/\s+/u, 2);
  return Object.freeze({
    behind: parseCount(left, "the upstream-only count"),
    ahead: parseCount(right, "the HEAD-only count"),
  });
}

/**
 * The `git push` invocation. The explicit refspec binds the checked-out local
 * branch to its resolved upstream branch, and no force flag is reachable here.
 */
export function pushArgv(remote: string, branch: string, trackingRef: string): readonly string[] {
  return Object.freeze(["push", "--no-follow-tags", "--", remote, `refs/heads/${branch}:${trackingRef}`]);
}