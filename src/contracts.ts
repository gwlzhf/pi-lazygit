export const MAX_PREVIEW_BYTES = 1_048_576;
export const MAX_PREVIEW_LINES = 5_000;
export const MAX_FILESYSTEM_ENTRIES = 20_000;

/** Largest share of the panel interior the project tree may occupy. */
export const TREE_MAX_RATIO = 0.3;
/** Smallest share of the panel interior the project tree may occupy. */
export const TREE_MIN_RATIO = 0.05;
/** Tree width the panel opens with when nothing was persisted. */
export const DEFAULT_TREE_RATIO = TREE_MAX_RATIO;
/** Smallest tree pane width in columns, unless the interior is narrower. */
export const TREE_MIN_COLUMNS = 12;

export type ViewMode = "modified" | "all";
export type ChangeScope = "workspace" | "session";
export type StatusCode = "M" | "A" | "D" | "R" | "?" | "U";

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

export interface ProjectSnapshot {
  readonly kind: "git" | "filesystem";
  readonly root: string;
  readonly hasHead: boolean;
  readonly allFiles: readonly string[];
  readonly workspaceChanges: ReadonlyMap<string, ChangeRecord>;
  readonly sessionChanges: ReadonlyMap<string, ChangeRecord>;
  readonly workspaceSummary: ChangeSummary;
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

export interface RefreshOptions {
  readonly signal: AbortSignal;
}

export interface PreviewOptions {
  readonly signal: AbortSignal;
}

export interface ReviewSource {
  refresh(options: RefreshOptions): Promise<ProjectSnapshot>;
  preview(path: string, options: PreviewOptions): Promise<FilePreview>;
}

export interface BaselineEntry {
  readonly status: StatusCode;
  readonly hash: string | null;
}

export interface RepositoryBaseline {
  readonly root: string;
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
