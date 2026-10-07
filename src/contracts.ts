export const MAX_PREVIEW_BYTES = 1_048_576;
export const MAX_PREVIEW_LINES = 5_000;
export const MAX_FILESYSTEM_ENTRIES = 20_000;

/** Tree width the panel opens with when nothing was persisted. */
export const DEFAULT_TREE_RATIO = 0.3;
/** Smallest share of the panel interior the project tree may occupy. */
export const TREE_MIN_RATIO = 0.05;
/** Smallest preview pane width in columns when both panes are shown. */
export const TREE_MIN_PREVIEW_COLUMNS = 40;
/** Smallest tree pane width in columns, unless the interior is narrower. */
export const TREE_MIN_COLUMNS = 12;

export type ViewMode = "modified" | "all";
export type ChangeScope = "workspace" | "session";
export type StatusCode = "M" | "A" | "D" | "R" | "?" | "U";

/** How a Git diff preview is laid out: one unified column, or old/new columns. */
export type DiffLayout = "unified" | "split";
/** Diff layout the panel opens with when nothing was persisted. */
export const DEFAULT_DIFF_LAYOUT: DiffLayout = "unified";

/**
 * Context line count that makes `git diff` emit the whole file around every
 * hunk. Git clamps the value to the file length, so a large constant is enough.
 */
export const FULL_DIFF_CONTEXT = 100_000;
/** Unchanged-line counts cycled by the preview, ending at whole-file context. */
export const DIFF_CONTEXT_LEVELS: readonly number[] = [3, 10, 25, FULL_DIFF_CONTEXT];
/** Context line count the panel opens with when nothing was persisted. */
export const DEFAULT_DIFF_CONTEXT = 3;
/** Default opacity for tinted addition/removal diff masks. */
export const DEFAULT_DIFF_MASK_OPACITY = 1;

/** Accept a finite diff mask opacity in the inclusive 0..1 range. */
export function normalizeDiffMaskOpacity(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

export function isDiffLayout(value: unknown): value is DiffLayout {
  return value === "unified" || value === "split";
}

/** Accept a stored context level, or reject anything outside the cycle. */
export function normalizeDiffContext(value: unknown): number | undefined {
  return typeof value === "number" && DIFF_CONTEXT_LEVELS.includes(value) ? value : undefined;
}

export function nextDiffContext(context: number): number {
  const index = DIFF_CONTEXT_LEVELS.indexOf(context);
  return DIFF_CONTEXT_LEVELS[(index + 1) % DIFF_CONTEXT_LEVELS.length] ?? DEFAULT_DIFF_CONTEXT;
}

export function diffContextLabel(context: number): string {
  return context >= FULL_DIFF_CONTEXT ? "full" : String(context);
}

export interface ChangeRecord {
  readonly path: string;
  readonly oldPath?: string;
  readonly index: string;
  readonly worktree: string;
  readonly status: StatusCode;
}

export interface ChangeSummary {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface FileLineSummary {
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitBranch {
  readonly name: string;
  readonly current: boolean;
}

export interface GitBranchSnapshot {
  readonly branches: readonly GitBranch[];
  readonly current?: string;
  readonly detachedAt?: string;
}

export interface SwitchBranchOptions {
  readonly signal: AbortSignal;
}

/**
 * Whether a change already sits in the index. Porcelain reports the index and
 * the working tree as the two-character pair `XY`, and an unmerged path or an
 * untracked one leaves the index column blank or `?`.
 */
export function isStaged(record: ChangeRecord): boolean {
  if (record.status === "U") return false;
  return record.index !== " " && record.index !== "?";
}

/** Whether a path can be handed to `git commit -- <paths>` at all. */
export function isCommittable(record: ChangeRecord): boolean {
  return record.status !== "U";
}

/** The HEAD commit message, split so an amend can replace only the subject. */
export interface HeadMessage {
  readonly subject: string;
  readonly body?: string;
  /** Whether HEAD is already contained in its upstream's history. */
  readonly pushed: boolean;
}

export interface CommitOptions {
  readonly message: string;
  /** Project paths that may be committed; `git commit -- <paths>` is the fence. */
  readonly paths: readonly string[];
  /** Report what would be committed instead of committing it. */
  readonly dryRun?: boolean;
  readonly noVerify?: boolean;
  readonly signal: AbortSignal;
}

export interface CommitResult {
  readonly dryRun: boolean;
  /** Git's own report, shown verbatim in the confirmation surface. */
  readonly output: string;
  /** Paths committed, after renames contribute both their old and new name. */
  readonly files: number;
}

export interface AmendOptions {
  readonly subject: string;
  /** Replayed verbatim so an amend of the title cannot drop the body. */
  readonly body?: string;
  readonly noVerify?: boolean;
  readonly signal: AbortSignal;
}

export interface AmendResult {
  readonly oid: string;
  /** The message Git stored, so a `commit-msg` hook rewrite stays visible. */
  readonly subject: string;
  readonly body?: string;
}

export interface PushCandidate {
  readonly oid: string;
  readonly shortOid: string;
  readonly subject: string;
}

/** Everything the two-stage push confirmation needs, computed up front. */
export interface PushPlan {
  readonly branch: string;
  /** Absent when the branch tracks nothing and needs `-u` first. */
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly commits: readonly PushCandidate[];
  readonly truncated: boolean;
}

export interface PushOptions {
  readonly branch: string;
  readonly upstream: string;
  readonly signal: AbortSignal;
}

export interface PushResult {
  readonly branch: string;
  readonly upstream: string;
  readonly output: string;
}

export interface ProjectSnapshot {
  readonly kind: "git" | "filesystem";
  readonly root: string;
  readonly hasHead: boolean;
  readonly currentBranch?: string;
  readonly detachedAt?: string;
  readonly allFiles: readonly string[];
  readonly workspaceChanges: ReadonlyMap<string, ChangeRecord>;
  readonly sessionChanges: ReadonlyMap<string, ChangeRecord>;
  readonly workspaceSummary: ChangeSummary;
  readonly workspaceSummaryByPath: ReadonlyMap<string, FileLineSummary>;
  readonly sessionSummary: ChangeSummary;
  readonly baselineEstablishedAt?: number;
  readonly truncated: boolean;
}

export interface FilePreview {
  readonly path: string;
  readonly kind: "diff" | "text" | "binary" | "error";
  readonly lines: readonly string[];
  readonly byteSize?: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface GitLogEntry {
  readonly oid: string;
  readonly shortOid: string;
  readonly subject: string;
  readonly author: string;
  readonly authoredAt: number;
}

export interface GitLogSnapshot {
  readonly entries: readonly GitLogEntry[];
  readonly truncated: boolean;
}

export interface CommitDiffPreview {
  readonly oid: string;
  readonly kind: "diff" | "error";
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly error?: string;
}

export interface RefreshOptions {
  readonly signal: AbortSignal;
}

export interface WatchOptions {
  readonly signal: AbortSignal;
  readonly onChange: () => void;
  readonly onError: (error: unknown) => void;
}

export interface PreviewOptions {
  readonly signal: AbortSignal;
  /** Select a bounded working-tree file preview instead of a Git diff. */
  readonly mode?: "diff" | "content";
  /** Unchanged lines Git keeps around each hunk; ignored by non-diff previews. */
  readonly diffContext?: number;
}

export interface ReviewSource {
  refresh(options: RefreshOptions): Promise<ProjectSnapshot>;
  preview(path: string, options: PreviewOptions): Promise<FilePreview>;
  history(options: RefreshOptions): Promise<GitLogSnapshot>;
  commitDiff(oid: string, options: PreviewOptions): Promise<CommitDiffPreview>;
  branches(options: RefreshOptions): Promise<GitBranchSnapshot>;
  switchBranch(name: string, options: SwitchBranchOptions): Promise<void>;
  watch(options: WatchOptions): Promise<void>;
  /** Undefined outside a repository, on an unborn HEAD, or while detached. */
  headMessage(options: RefreshOptions): Promise<HeadMessage | undefined>;
  commit(options: CommitOptions): Promise<CommitResult>;
  amend(options: AmendOptions): Promise<AmendResult>;
  /** Rejects when the branch tracks nothing, so a blind push cannot happen. */
  pushPlan(options: RefreshOptions): Promise<PushPlan>;
  push(options: PushOptions): Promise<PushResult>;
}

export interface BaselineEntry {
  readonly status: StatusCode;
  readonly hash: string | null;
}

export interface RepositoryBaseline {
  readonly root: string;
  readonly headIdentity: string;
  readonly establishedAt: number;
  readonly entries: ReadonlyMap<string, BaselineEntry>;
}

export function emptySummary(): ChangeSummary {
  return { files: 0, insertions: 0, deletions: 0 };
}

export function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function changeMap(records: readonly ChangeRecord[]): Map<string, ChangeRecord> {
  const result = new Map<string, ChangeRecord>();
  for (const record of records) {
    const path = normalizeProjectPath(record.path);
    result.set(path, path === record.path ? record : { ...record, path });
  }
  return result;
}
