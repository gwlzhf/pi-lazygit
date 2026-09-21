import {
  DEFAULT_DIFF_CONTEXT,
  DEFAULT_DIFF_LAYOUT,
  DEFAULT_TREE_RATIO,
  isDiffLayout,
  nextDiffContext,
  normalizeDiffContext,
  TREE_MAX_RATIO,
  TREE_MIN_COLUMNS,
  TREE_MIN_RATIO,
  type ChangeRecord,
  type ChangeScope,
  type CommitDiffPreview,
  type DiffLayout,
  type FilePreview,
  type GitBranchSnapshot,
  type GitLogEntry,
  type GitLogSnapshot,
  type ProjectSnapshot,
  type ReviewSource,

  type ViewMode,
} from "../contracts";
const OSC_SEQUENCE = /(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c)/gu;
const STRING_SEQUENCE = /(?:\x1b[P_X^]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c)/gu;
const CSI_SEQUENCE = /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_SEQUENCE = /\x1b[ -/]*[0-~]/gu;
const UNSAFE_CONTROLS = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu;

function sanitizeError(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replaceAll("\x1b", "")
    .replace(UNSAFE_CONTROLS, "");
}
import {
  buildChangeList,
  buildTree,
  flattenTree,
  recoverSelection,
  type TreeNode,
  type TreeRow,
  visiblePaths,
} from "../model/tree";
import { parseUnifiedDiff } from "./diff-view";
import { type HighlightThemeName, DEFAULT_HIGHLIGHT_THEME } from "../highlight-theme";

export type PanelFocus = "tree" | "preview";
export type LeftMode = "files" | "log" | "branches";
export type ListLayout = "tree" | "changes";

export interface ReviewControllerState {
  readonly revision: number;
  readonly leftMode: LeftMode;
  readonly listLayout: ListLayout;
  readonly viewMode: ViewMode;
  readonly scope: ChangeScope;
  readonly focus: PanelFocus;
  readonly snapshot: ProjectSnapshot | undefined;
  readonly rows: readonly TreeRow[];
  readonly expanded: ReadonlySet<string>;
  readonly selectedIndex: number;
  readonly preview: FilePreview | undefined;
  readonly previewPath: string | undefined;
  readonly previewLoading: boolean;
  readonly previewScroll: number;
  readonly history: GitLogSnapshot | undefined;
  readonly historyLoading: boolean;
  readonly historyError: string | undefined;
  readonly logSelectedIndex: number;
  readonly commitDiff: CommitDiffPreview | undefined;
  readonly commitDiffLoading: boolean;
  readonly refreshLoading: boolean;
  readonly refreshError: string | undefined;
  readonly watchError: string | undefined;
  readonly treeRatio: number;
  readonly treeCollapsed: boolean;
  readonly diffLayout: DiffLayout;
  readonly diffContext: number;
  readonly highlightTheme: HighlightThemeName;
  readonly branches: GitBranchSnapshot | undefined;
  readonly branchSelectedIndex: number;
  readonly branchLoading: boolean;
  readonly branchSwitching: string | undefined;
  readonly branchError: string | undefined;
}

export interface ReviewControllerOptions {
  readonly cwd: string;
  readonly source: ReviewSource;
  readonly treeRatio?: number;
  readonly onTreeRatioChange?: (ratio: number) => void;
  readonly treeCollapsed?: boolean;
  readonly onTreeCollapsedChange?: (collapsed: boolean) => void;
  readonly diffLayout?: DiffLayout;
  readonly onDiffLayoutChange?: (layout: DiffLayout) => void;
  readonly diffContext?: number;
  readonly onDiffContextChange?: (context: number) => void;
  readonly highlightTheme?: HighlightThemeName;
  readonly onHighlightThemeChange?: (theme: HighlightThemeName) => void;
  readonly onChange: () => void;
}

const SPLIT_DIFF_MINIMUM_WIDTH = 40;
const EMPTY_CHANGES: ReadonlyMap<string, ChangeRecord> = new Map();

function errorMessage(error: unknown): string {
  return sanitizeError(error instanceof Error ? error.message : String(error)).replaceAll("\n", " ");
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function collectDirectoryPaths(node: TreeNode, result: Set<string>): void {
  for (const child of node.children) {
    if (child.kind !== "directory") continue;
    result.add(child.path);
    collectDirectoryPaths(child, result);
  }
}

export class ReviewController {
  readonly #cwd: string;
  readonly #source: ReviewSource;
  readonly #onTreeRatioChange: ((ratio: number) => void) | undefined;
  readonly #onTreeCollapsedChange: ((collapsed: boolean) => void) | undefined;
  readonly #onDiffLayoutChange: ((layout: DiffLayout) => void) | undefined;
  readonly #onDiffContextChange: ((context: number) => void) | undefined;
  readonly #onHighlightThemeChange: ((theme: HighlightThemeName) => void) | undefined;
  readonly #onChange: () => void;

  #leftMode: LeftMode = "files";
  #listLayout: ListLayout = "tree";
  #viewMode: ViewMode = "modified";
  #scope: ChangeScope = "workspace";
  #focus: PanelFocus;
  #snapshot: ProjectSnapshot | undefined;
  #rows: readonly TreeRow[] = [];
  #expanded = new Set<string>();
  #expansionInitialized = false;
  #selectedIndex = -1;
  #preview: FilePreview | undefined;
  #previewPath: string | undefined;
  #previewLoading = false;
  #history: GitLogSnapshot | undefined;
  #historyLoading = false;
  #historyError: string | undefined;
  #historyController: AbortController | undefined;
  #historyGeneration = 0;
  #logSelectedIndex = -1;
  #commitDiff: CommitDiffPreview | undefined;
  #commitDiffLoading = false;
  #commitDiffController: AbortController | undefined;
  #commitDiffGeneration = 0;
  #previewScroll = 0;
  #refreshLoading = false;
  #refreshError: string | undefined;
  #watchError: string | undefined;
  #refreshController: AbortController | undefined;
  #previewController: AbortController | undefined;
  #watchController: AbortController | undefined;
  #refreshGeneration = 0;
  #previewGeneration = 0;
  #watchGeneration = 0;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshQueued = false;
  #treeRatio: number;
  #treeCollapsed: boolean;
  #diffLayout: DiffLayout;
  #diffContext: number;
  #previewWidth = 0;
  #highlightTheme: HighlightThemeName;
  #revision = 0;
  #started = false;
  #disposed = false;
  #branches: GitBranchSnapshot | undefined;
  #branchSelectedIndex = -1;
  #branchLoading = false;
  #branchSwitching: string | undefined;
  #branchError: string | undefined;
  #branchesController: AbortController | undefined;
  #branchesGeneration = 0;
  #branchSwitchController: AbortController | undefined;
  #branchSwitchGeneration = 0;

  constructor(options: ReviewControllerOptions) {
    this.#cwd = options.cwd;
    this.#source = options.source;
    this.#onTreeRatioChange = options.onTreeRatioChange;
    this.#onTreeCollapsedChange = options.onTreeCollapsedChange;
    this.#onDiffLayoutChange = options.onDiffLayoutChange;
    this.#onDiffContextChange = options.onDiffContextChange;
    this.#onHighlightThemeChange = options.onHighlightThemeChange;
    this.#onChange = options.onChange;
    this.#treeRatio = Math.max(TREE_MIN_RATIO, Math.min(TREE_MAX_RATIO, options.treeRatio ?? DEFAULT_TREE_RATIO));
    this.#treeCollapsed = options.treeCollapsed ?? false;
    this.#focus = this.#treeCollapsed ? "preview" : "tree";
    this.#diffLayout = isDiffLayout(options.diffLayout) ? options.diffLayout : DEFAULT_DIFF_LAYOUT;
    this.#diffContext = normalizeDiffContext(options.diffContext) ?? DEFAULT_DIFF_CONTEXT;
    this.#highlightTheme = options.highlightTheme ?? DEFAULT_HIGHLIGHT_THEME;
  }

  get state(): ReviewControllerState {
    return {
      revision: this.#revision,
      leftMode: this.#leftMode,
      listLayout: this.#listLayout,
      viewMode: this.#viewMode,
      scope: this.#scope,
      focus: this.#focus,
      snapshot: this.#snapshot,
      rows: this.#rows,
      expanded: new Set(this.#expanded),
      selectedIndex: this.#selectedIndex,
      preview: this.#preview,
      previewPath: this.#previewPath,
      previewLoading: this.#previewLoading,
      previewScroll: this.#previewScroll,
      history: this.#history,
      historyLoading: this.#historyLoading,
      historyError: this.#historyError,
      logSelectedIndex: this.#logSelectedIndex,
      commitDiff: this.#commitDiff,
      commitDiffLoading: this.#commitDiffLoading,
      refreshLoading: this.#refreshLoading,
      refreshError: this.#refreshError,
      watchError: this.#watchError,
      treeRatio: this.#treeRatio,
      treeCollapsed: this.#treeCollapsed,
      diffLayout: this.#diffLayout,
      diffContext: this.#diffContext,
      highlightTheme: this.#highlightTheme,
      branches: this.#branches,
      branchSelectedIndex: this.#branchSelectedIndex,
      branchLoading: this.#branchLoading,
      branchSwitching: this.#branchSwitching,
      branchError: this.#branchError,
    };
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#queueRefresh();
  }

  refresh(): void {
    this.#queueRefresh();
  }

  focusTree(): void {
    if (this.#disposed) return;
    if (this.#treeCollapsed) {
      this.#treeCollapsed = false;
      this.#focus = "tree";
      this.#onTreeCollapsedChange?.(false);
      this.#changed();
      return;
    }
    if (this.#focus !== "tree") {
      this.#focus = "tree";
      this.#changed();
    }
  }

  focusPreview(): void {
    if (this.#disposed || this.#focus === "preview") return;
    this.#focus = "preview";
    this.#changed();
  }

  toggleFocus(): void {
    if (this.#treeCollapsed || this.#disposed) return;
    this.#focus = this.#focus === "tree" ? "preview" : "tree";
    this.#changed();
  }

  setTreeCollapsed(collapsed: boolean): void {
    if (this.#disposed || this.#treeCollapsed === collapsed) return;
    this.#treeCollapsed = collapsed;
    this.#focus = collapsed ? "preview" : "tree";
    this.#onTreeCollapsedChange?.(collapsed);
    this.#changed();
  }

  resizeTree(deltaColumns: number, panelWidth: number): void {
    if (this.#disposed) return;
    if (this.#treeCollapsed) {
      if (deltaColumns > 0) this.setTreeCollapsed(false);
      return;
    }
    if (panelWidth < 80) return;
    this.setTreeColumns(this.#treeWidth(panelWidth) + deltaColumns, panelWidth);
  }

  setTreeColumns(columns: number, panelWidth: number): void {
    if (this.#disposed) return;
    const available = Math.max(0, Math.floor(panelWidth) - 3);
    if (available === 0) return;
    const maximum = Math.floor(available * TREE_MAX_RATIO);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(columns)));
    if (clamped === this.#treeWidth(panelWidth)) return;
    this.#treeRatio = clamped / available;
    this.#onTreeRatioChange?.(this.#treeRatio);
    this.#changed();
  }

  toggleDiffLayout(): void {
    if (this.#disposed) return;
    this.#diffLayout = this.#diffLayout === "unified" ? "split" : "unified";
    this.#onDiffLayoutChange?.(this.#diffLayout);
    this.#changed();
  }
  setHighlightTheme(theme: HighlightThemeName): void {
    if (this.#disposed || this.#highlightTheme === theme) return;
    this.#highlightTheme = theme;
    this.#onHighlightThemeChange?.(theme);
    this.#changed();
  }

  cycleDiffContext(): void {
    if (this.#disposed) return;
    this.#diffContext = nextDiffContext(this.#diffContext);
    this.#onDiffContextChange?.(this.#diffContext);
    if (this.#leftMode === "log") {
      const entry = this.#selectedLogEntry();
      if (entry !== undefined) this.#beginCommitDiff(entry.oid, true);
    } else if (this.#previewPath !== undefined) {
      this.#beginPreview(this.#previewPath, true);
    }
    this.#changed();
  }

  setViewMode(mode: ViewMode): void {
    if (this.#disposed || this.#snapshot?.kind !== "git" || this.#viewMode === mode) return;
    this.#viewMode = mode;
    this.#rebuildRows();
    this.#changed();
  }

  /**
   * Swaps the directory tree for the flat modified/untracked change list. The
   * list needs Git status, so the key is inert on the filesystem fallback.
   */
  toggleListLayout(): void {
    if (this.#disposed || this.#snapshot?.kind !== "git") return;
    this.#listLayout = this.#listLayout === "changes" ? "tree" : "changes";
    this.#rebuildRows();
    this.#changed();
  }

  toggleScope(): void {
    if (this.#disposed || this.#snapshot?.kind !== "git") return;
    this.#scope = this.#scope === "workspace" ? "session" : "workspace";
    this.#rebuildRows();
    this.#changed();
  }

  toggleLeftMode(): void {
    if (this.#disposed || this.#snapshot?.kind !== "git") return;
    if (this.#treeCollapsed) {
      this.#treeCollapsed = false;
      this.#onTreeCollapsedChange?.(false);
    }
    this.#focus = "tree";
    this.#previewScroll = 0;
    if (this.#leftMode === "files") {
      this.#leftMode = "log";
      this.#cancelPreview();
      this.#beginHistory();
    } else {
      this.#leftMode = "files";
      this.#cancelHistory();
      this.#cancelCommitDiff();
      this.#rebuildRows(true);
    }
    this.#changed();
  }

  movePrimarySelection(delta: number): void {
    if (this.#disposed) return;
    if (this.#leftMode === "log") {
      this.#moveLogSelection(delta);
      return;
    }
    if (this.#leftMode === "branches") {
      this.#moveBranchSelection(delta);
      return;
    }
    if (this.#rows.length === 0) return;
    const clamped = Math.max(0, Math.min(this.#rows.length - 1, this.#selectedIndex + delta));
    const next = this.#skipSections(clamped, delta < 0 ? -1 : 1);
    if (next < 0 || next === this.#selectedIndex) return;
    this.#selectedIndex = next;
    this.#selectionChanged();
  }

  selectPrimary(index: number): void {
    if (this.#disposed) return;
    if (this.#leftMode === "branches") {
      const length = this.#branches?.branches.length ?? 0;
      if (length === 0) return;
      const next = Math.max(0, Math.min(length - 1, Math.floor(index)));
      if (next === this.#branchSelectedIndex) return;
      this.#branchSelectedIndex = next;
      this.#changed();
      return;
    }
    const length = this.#leftMode === "log" ? this.#history?.entries.length ?? 0 : this.#rows.length;
    if (length === 0) return;
    const next = Math.max(0, Math.min(length - 1, Math.floor(index)));
    if (this.#leftMode === "log") {
      if (next === this.#logSelectedIndex) return;
      this.#logSelectedIndex = next;
      this.#previewScroll = 0;
      const entry = this.#selectedLogEntry();
      if (entry !== undefined) this.#beginCommitDiff(entry.oid);
      this.#changed();
      return;
    }
    // A divider is a label, so clicking one keeps the current file selected.
    if (next === this.#selectedIndex || this.#rows[next]?.node.kind === "section") return;
    this.#selectedIndex = next;
    this.#selectionChanged();
  }

  toggleBranches(): void {
    if (this.#disposed || this.#snapshot?.kind !== "git" || this.#branchSwitching !== undefined) return;
    if (this.#leftMode === "branches") {
      this.#leftMode = "files";
      this.#cancelBranches();
      this.#focus = "tree";
      this.#rebuildRows(true);
      this.#changed();
      return;
    }
    if (this.#treeCollapsed) {
      this.#treeCollapsed = false;
      this.#onTreeCollapsedChange?.(false);
    }
    this.#focus = "tree";
    this.#previewScroll = 0;
    if (this.#leftMode === "log") {
      this.#cancelHistory();
      this.#cancelCommitDiff();
    } else {
      this.#cancelPreview();
    }
    this.#leftMode = "branches";
    this.#branchError = undefined;
    this.#beginBranches();
    this.#changed();
  }

  switchSelectedBranch(): void {
    if (this.#disposed || this.#leftMode !== "branches" || this.#branchSwitching !== undefined) return;
    const branch = this.#branches?.branches[this.#branchSelectedIndex];
    if (branch === undefined) return;
    if (branch.current) {
      this.#leftMode = "files";
      this.#focus = "tree";
      this.#cancelBranches();
      this.#rebuildRows(true);
      this.#changed();
      return;
    }
    this.#branchError = undefined;
    this.#branchSwitching = branch.name;
    this.#cancelPreview();
    this.#cancelHistory();
    this.#cancelCommitDiff();
    this.#cancelRefresh();
    this.#stopWatch();
    const generation = ++this.#branchSwitchGeneration;
    const controller = new AbortController();
    this.#branchSwitchController = controller;
    this.#changed();
    void this.#source.switchBranch(branch.name, { signal: controller.signal }).then(
      () => {
        if (!this.#isCurrentBranchSwitch(generation, controller)) return;
        this.#branchSwitchController = undefined;
        this.#branchSwitching = undefined;
        this.#leftMode = "files";
        this.#focus = "tree";
        this.#cancelBranches();
        this.#rows = [];
        this.#selectedIndex = -1;
        this.#expanded = new Set();
        this.#expansionInitialized = false;
        this.#cancelPreview();
        this.#beginRefresh();
        this.#changed();
      },
      error => {
        if (!this.#isCurrentBranchSwitch(generation, controller) || isAbort(error, controller.signal)) return;
        this.#branchSwitchController = undefined;
        this.#branchSwitching = undefined;
        this.#branchError = errorMessage(error);
        this.#installWatch();
        this.#changed();
      },
    );
  }

  collapseOrParent(): void {
    if (this.#disposed) return;
    const selected = this.#selectedRow();
    if (selected === undefined) return;
    if (selected.node.kind === "directory" && selected.expanded) {
      this.#expanded.delete(selected.node.path);
      this.#rows = flattenTree(buildTree(this.#visiblePaths(), this.#activeChanges()), this.#expanded);
      this.#selectedIndex = recoverSelection(this.#rows, selected.node.path, this.#selectedIndex);
      this.#selectionChanged();
      return;
    }
    if (selected.depth === 0) return;
    for (let index = this.#selectedIndex - 1; index >= 0; index -= 1) {
      const candidate = this.#rows[index];
      if (candidate?.node.kind === "directory" && candidate.depth === selected.depth - 1) {
        this.#selectedIndex = index;
        this.#selectionChanged();
        return;
      }
    }
  }

  expandOrChild(): void {
    if (this.#disposed) return;
    const selected = this.#selectedRow();
    if (selected?.node.kind !== "directory") return;
    if (!selected.expanded) {
      this.#expanded.add(selected.node.path);
      this.#rows = flattenTree(buildTree(this.#visiblePaths(), this.#activeChanges()), this.#expanded);
      this.#selectedIndex = recoverSelection(this.#rows, selected.node.path, this.#selectedIndex);
      this.#selectionChanged();
      return;
    }
    const child = this.#rows[this.#selectedIndex + 1];
    if (child !== undefined && child.depth === selected.depth + 1) {
      this.#selectedIndex += 1;
      this.#selectionChanged();
    }
  }

  openSelection(): void {
    if (this.#disposed) return;
    if (this.#leftMode === "log") {
      if (this.#selectedLogEntry() !== undefined && this.#focus !== "preview") {
        this.#focus = "preview";
        this.#changed();
      }
      return;
    }
    const selected = this.#selectedRow();
    if (selected === undefined || selected.node.kind === "section") return;
    if (selected.node.kind === "directory") {
      if (selected.expanded) this.collapseOrParent();
      else this.expandOrChild();
      return;
    }
    const loadingBefore = this.#previewLoading;
    const previewBefore = this.#preview;
    const pathBefore = this.#previewPath;
    const focusBefore = this.#focus;
    this.#beginPreview(selected.node.path);
    if (this.#focus !== "preview") this.#focus = "preview";
    if (pathBefore !== this.#previewPath || loadingBefore !== this.#previewLoading || previewBefore !== this.#preview || focusBefore !== this.#focus) {
      this.#changed();
    }
  }

  setPreviewWidth(width: number): void {
    this.#previewWidth = Math.max(0, Math.floor(width));
  }

  scrollPreview(delta: number, viewportHeight: number): void {
    this.#setPreviewScroll(this.#previewScroll + delta, viewportHeight);
  }

  scrollPreviewHome(viewportHeight: number): void {
    this.#setPreviewScroll(0, viewportHeight);
  }

  scrollPreviewEnd(viewportHeight: number): void {
    this.#setPreviewScroll(Number.MAX_SAFE_INTEGER, viewportHeight);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#refreshGeneration += 1;
    this.#previewGeneration += 1;
    this.#historyGeneration += 1;
    this.#commitDiffGeneration += 1;
    this.#watchGeneration += 1;
    this.#branchesGeneration += 1;
    this.#branchSwitchGeneration += 1;
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#refreshQueued = false;
    this.#refreshController?.abort();
    this.#previewController?.abort();
    this.#historyController?.abort();
    this.#commitDiffController?.abort();
    this.#watchController?.abort();
    this.#branchesController?.abort();
    this.#branchSwitchController?.abort();
    this.#refreshController = undefined;
    this.#previewController = undefined;
    this.#historyController = undefined;
    this.#commitDiffController = undefined;
    this.#watchController = undefined;
    this.#branchesController = undefined;
    this.#branchSwitchController = undefined;
  }

  #changed(): void {
    if (this.#disposed) return;
    this.#revision += 1;
    this.#onChange();
  }

  #treeWidth(width: number): number {
    const available = Math.max(0, Math.floor(width) - 3);
    const maximum = Math.floor(available * TREE_MAX_RATIO);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    return Math.max(minimum, Math.min(maximum, Math.round(available * this.#treeRatio)));
  }

  #queueRefresh(debounce = false): void {
    if (this.#disposed) return;
    if (debounce) {
      if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
      this.#refreshTimer = setTimeout(() => {
        this.#refreshTimer = undefined;
        this.#startQueuedRefresh();
      }, 150);
      return;
    }
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#startQueuedRefresh();
  }

  #startQueuedRefresh(): void {
    if (this.#disposed) return;
    if (this.#refreshController !== undefined) {
      this.#refreshQueued = true;
      return;
    }
    this.#beginRefresh();
  }

  #beginRefresh(): void {
    if (this.#disposed || this.#refreshController !== undefined) return;
    const generation = ++this.#refreshGeneration;
    if (this.#leftMode === "log") {
      this.#cancelCommitDiff();
    } else {
      this.#previewGeneration += 1;
      this.#previewController?.abort();
      this.#previewController = undefined;
      this.#previewLoading = false;
    }
    const controller = new AbortController();
    this.#refreshController = controller;
    this.#refreshLoading = true;
    this.#refreshError = undefined;
    this.#changed();
    void this.#source.refresh({ signal: controller.signal }).then(
      project => {
        if (!this.#isCurrentRefresh(generation, controller)) return;
        this.#refreshController = undefined;
        this.#refreshLoading = false;
        this.#snapshot = project;
        this.#watchError = undefined;
        if (project.kind === "git") {
          this.#installWatch();
          if (this.#leftMode === "log") this.#beginHistory();
          else if (this.#leftMode === "files") this.#rebuildRows(true);
        } else {
          this.#stopWatch();
          if (this.#leftMode !== "files") this.#leftMode = "files";
          this.#rebuildRows(true);
        }
        this.#changed();
        this.#runCoalescedRefresh();
      },
      error => {
        if (!this.#isCurrentRefresh(generation, controller) || isAbort(error, controller.signal)) return;
        this.#refreshController = undefined;
        this.#refreshLoading = false;
        this.#refreshError = errorMessage(error);
        this.#changed();
        this.#runCoalescedRefresh();
      },
    );
  }

  #runCoalescedRefresh(): void {
    if (!this.#refreshQueued) return;
    this.#refreshQueued = false;
    this.#beginRefresh();
  }

  #isCurrentRefresh(generation: number, controller: AbortController): boolean {
    return !this.#disposed && generation === this.#refreshGeneration && this.#refreshController === controller;
  }

  #cancelRefresh(): void {
    this.#refreshGeneration += 1;
    this.#refreshController?.abort();
    this.#refreshController = undefined;
    this.#refreshLoading = false;
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#refreshQueued = false;
  }

  #beginBranches(): void {
    if (this.#disposed) return;
    const generation = ++this.#branchesGeneration;
    this.#branchesController?.abort();
    const controller = new AbortController();
    this.#branchesController = controller;
    this.#branchLoading = true;
    void this.#source.branches({ signal: controller.signal }).then(
      result => {
        if (!this.#isCurrentBranches(generation, controller)) return;
        this.#branchesController = undefined;
        this.#branchLoading = false;
        this.#branches = result;
        const currentIndex = result.branches.findIndex(branch => branch.current);
        this.#branchSelectedIndex = result.branches.length === 0 ? -1 : Math.max(0, currentIndex);
        this.#changed();
      },
      error => {
        if (!this.#isCurrentBranches(generation, controller) || isAbort(error, controller.signal)) return;
        this.#branchesController = undefined;
        this.#branchLoading = false;
        this.#branchError = errorMessage(error);
        this.#changed();
      },
    );
  }

  #isCurrentBranches(generation: number, controller: AbortController): boolean {
    return !this.#disposed
      && this.#leftMode === "branches"
      && generation === this.#branchesGeneration
      && this.#branchesController === controller;
  }

  #cancelBranches(): void {
    this.#branchesGeneration += 1;
    this.#branchesController?.abort();
    this.#branchesController = undefined;
    this.#branchLoading = false;
  }

  #moveBranchSelection(delta: number): void {
    const length = this.#branches?.branches.length ?? 0;
    if (length === 0) return;
    const next = Math.max(0, Math.min(length - 1, this.#branchSelectedIndex + delta));
    if (next === this.#branchSelectedIndex) return;
    this.#branchSelectedIndex = next;
    this.#changed();
  }

  #isCurrentBranchSwitch(generation: number, controller: AbortController): boolean {
    return !this.#disposed
      && generation === this.#branchSwitchGeneration
      && this.#branchSwitchController === controller;
  }

  #installWatch(): void {
    if (this.#watchController !== undefined || this.#disposed) return;
    const generation = ++this.#watchGeneration;
    const controller = new AbortController();
    this.#watchController = controller;
    void this.#source.watch({
      signal: controller.signal,
      onChange: () => {
        if (!this.#isCurrentWatch(generation, controller)) return;
        this.#queueRefresh(true);
      },
      onError: error => this.#setWatchError(error, generation, controller),
    }).catch(error => this.#setWatchError(error, generation, controller));
  }

  #stopWatch(): void {
    this.#watchGeneration += 1;
    this.#watchController?.abort();
    this.#watchController = undefined;
  }

  #isCurrentWatch(generation: number, controller: AbortController): boolean {
    return !this.#disposed && generation === this.#watchGeneration && this.#watchController === controller && !controller.signal.aborted;
  }

  #setWatchError(error: unknown, generation: number, controller: AbortController): void {
    if (!this.#isCurrentWatch(generation, controller) || isAbort(error, controller.signal)) return;
    this.#watchGeneration += 1;
    this.#watchController = undefined;
    controller.abort();
    this.#watchError = errorMessage(error);
    this.#changed();
  }


  #beginHistory(): void {
    if (this.#disposed || this.#snapshot?.kind !== "git") return;
    const selectedOid = this.#selectedLogEntry()?.oid;
    const generation = ++this.#historyGeneration;
    this.#historyController?.abort();
    const controller = new AbortController();
    this.#historyController = controller;
    this.#historyLoading = true;
    this.#historyError = undefined;
    void this.#source.history({ signal: controller.signal }).then(
      history => {
        if (!this.#isCurrentHistory(generation, controller)) return;
        this.#historyController = undefined;
        this.#historyLoading = false;
        this.#history = history;
        const restored = selectedOid === undefined ? -1 : history.entries.findIndex(entry => entry.oid === selectedOid);
        this.#logSelectedIndex = history.entries.length === 0
          ? -1
          : restored >= 0
            ? restored
            : Math.min(Math.max(0, this.#logSelectedIndex), history.entries.length - 1);
        const entry = this.#selectedLogEntry();
        if (entry !== undefined) this.#beginCommitDiff(entry.oid);
        else this.#cancelCommitDiff();
        this.#changed();
      },
      error => {
        if (!this.#isCurrentHistory(generation, controller) || isAbort(error, controller.signal)) return;
        this.#historyController = undefined;
        this.#historyLoading = false;
        this.#historyError = errorMessage(error);
        this.#changed();
      },
    );
  }

  #isCurrentHistory(generation: number, controller: AbortController): boolean {
    return !this.#disposed
      && this.#leftMode === "log"
      && generation === this.#historyGeneration
      && this.#historyController === controller;
  }

  #cancelHistory(): void {
    this.#historyGeneration += 1;
    this.#historyController?.abort();
    this.#historyController = undefined;
    this.#historyLoading = false;
  }

  #moveLogSelection(delta: number): void {
    const entries = this.#history?.entries;
    if (entries === undefined || entries.length === 0) return;
    const next = Math.max(0, Math.min(entries.length - 1, this.#logSelectedIndex + delta));
    if (next === this.#logSelectedIndex) return;
    this.#logSelectedIndex = next;
    this.#previewScroll = 0;
    const entry = entries[next];
    if (entry !== undefined) this.#beginCommitDiff(entry.oid);
    this.#changed();
  }

  #selectedLogEntry(): GitLogEntry | undefined {
    return this.#logSelectedIndex < 0 ? undefined : this.#history?.entries[this.#logSelectedIndex];
  }

  #beginCommitDiff(oid: string, force = false): void {
    if (this.#disposed || (!force && this.#commitDiff?.oid === oid && (this.#commitDiffLoading || this.#commitDiff !== undefined))) return;
    const generation = ++this.#commitDiffGeneration;
    this.#commitDiffController?.abort();
    const controller = new AbortController();
    this.#commitDiffController = controller;
    this.#commitDiffLoading = true;
    this.#commitDiff = undefined;
    void this.#source.commitDiff(oid, { signal: controller.signal, diffContext: this.#diffContext }).then(
      preview => {
        if (!this.#isCurrentCommitDiff(generation, controller, oid)) return;
        this.#commitDiffController = undefined;
        this.#commitDiffLoading = false;
        this.#commitDiff = preview.oid === oid ? preview : { ...preview, oid };
        this.#previewScroll = 0;
        this.#changed();
      },
      error => {
        if (!this.#isCurrentCommitDiff(generation, controller, oid) || isAbort(error, controller.signal)) return;
        this.#commitDiffController = undefined;
        this.#commitDiffLoading = false;
        this.#commitDiff = { oid, kind: "error", lines: [], truncated: false, error: errorMessage(error) };
        this.#changed();
      },
    );
  }

  #isCurrentCommitDiff(generation: number, controller: AbortController, oid: string): boolean {
    return !this.#disposed
      && this.#leftMode === "log"
      && generation === this.#commitDiffGeneration
      && this.#commitDiffController === controller
      && this.#selectedLogEntry()?.oid === oid;
  }

  #cancelCommitDiff(): void {
    this.#commitDiffGeneration += 1;
    this.#commitDiffController?.abort();
    this.#commitDiffController = undefined;
    this.#commitDiffLoading = false;
    this.#commitDiff = undefined;
  }

  #activeChanges(): ReadonlyMap<string, ChangeRecord> {
    const project = this.#snapshot;
    if (project === undefined || project.kind === "filesystem") return EMPTY_CHANGES;
    return this.#scope === "workspace" ? project.workspaceChanges : project.sessionChanges;
  }

  #rebuildRows(forcePreview = false): void {
    const project = this.#snapshot;
    if (project === undefined) {
      this.#rows = [];
      this.#selectedIndex = -1;
      return;
    }
    const previousPath = this.#selectedRow()?.node.path;
    const previousIndex = this.#selectedIndex;
    const changes = this.#activeChanges();
    if (this.#usesChangeList()) {
      this.#rows = buildChangeList(changes);
      this.#selectedIndex = this.#skipSections(
        recoverSelection(this.#rows, previousPath, previousIndex),
        1,
      );
      const selectedChange = this.#selectedRow();
      if (selectedChange?.node.kind === "file") this.#beginPreview(selectedChange.node.path, forcePreview);
      else this.#cancelPreview();
      return;
    }
    const mode: ViewMode = project.kind === "filesystem" ? "all" : this.#viewMode;
    const paths = visiblePaths(project.allFiles, changes, mode);
    const root = buildTree(paths, changes);
    if (!this.#expansionInitialized) {
      collectDirectoryPaths(root, this.#expanded);
      this.#expansionInitialized = true;
    }
    this.#rows = flattenTree(root, this.#expanded);
    this.#selectedIndex = recoverSelection(this.#rows, previousPath, previousIndex);
    const selected = this.#selectedRow();
    if (selected?.node.kind === "file") this.#beginPreview(selected.node.path, forcePreview);
    else this.#cancelPreview();
  }

  #selectedRow(): TreeRow | undefined {
    return this.#selectedIndex >= 0 ? this.#rows[this.#selectedIndex] : undefined;
  }

  #usesChangeList(): boolean {
    return this.#listLayout === "changes" && this.#snapshot?.kind === "git";
  }

  /**
   * Walks past divider rows so the cursor always lands on a file, searching the
   * other direction when the preferred one runs out of rows.
   */
  #skipSections(index: number, step: 1 | -1): number {
    if (index < 0 || this.#rows.length === 0) return this.#rows.length === 0 ? -1 : index;
    for (const direction of [step, -step] as const) {
      for (let cursor = index; cursor >= 0 && cursor < this.#rows.length; cursor += direction) {
        if (this.#rows[cursor]?.node.kind !== "section") return cursor;
      }
    }
    return -1;
  }

  #selectionChanged(): void {
    this.#previewScroll = 0;
    const selected = this.#selectedRow();
    if (selected?.node.kind === "file") this.#beginPreview(selected.node.path);
    else this.#cancelPreview();
    this.#changed();
  }

  #visiblePaths(): readonly string[] {
    const project = this.#snapshot;
    if (project === undefined) return [];
    const mode: ViewMode = project.kind === "filesystem" ? "all" : this.#viewMode;
    return visiblePaths(project.allFiles, this.#activeChanges(), mode);
  }

  #beginPreview(path: string, force = false): void {
    if (this.#disposed || (!force && this.#previewPath === path && (this.#previewLoading || this.#preview !== undefined))) return;
    const samePath = this.#previewPath === path;
    const generation = ++this.#previewGeneration;
    this.#previewController?.abort();
    const controller = new AbortController();
    this.#previewController = controller;
    this.#previewPath = path;
    if (!samePath) {
      this.#preview = undefined;
      this.#previewScroll = 0;
    }
    this.#previewLoading = true;
    void this.#source.preview(path, { signal: controller.signal, diffContext: this.#diffContext }).then(
      result => {
        if (!this.#isCurrentPreview(generation, controller, path)) return;
        this.#previewController = undefined;
        this.#previewLoading = false;
        this.#preview = result.path === path ? result : { ...result, path };
        this.#previewScroll = 0;
        this.#changed();
      },
      error => {
        if (!this.#isCurrentPreview(generation, controller, path) || isAbort(error, controller.signal)) return;
        this.#previewController = undefined;
        this.#previewLoading = false;
        this.#preview = { path, kind: "error", lines: [], truncated: false, error: errorMessage(error) };
        this.#changed();
      },
    );
  }

  #isCurrentPreview(generation: number, controller: AbortController, path: string): boolean {
    return !this.#disposed
      && this.#leftMode === "files"
      && generation === this.#previewGeneration
      && this.#previewController === controller
      && this.#previewPath === path;
  }
  #cancelPreview(): void {
    this.#previewGeneration += 1;
    this.#previewController?.abort();
    this.#previewController = undefined;
    this.#previewPath = undefined;
    this.#preview = undefined;
    this.#previewLoading = false;
    this.#previewScroll = 0;
  }

  #previewLineCount(): number {
    const value = this.#leftMode === "log" ? this.#commitDiff : this.#preview;
    if (value === undefined) return 1;
    if (value.kind === "binary") return value.byteSize === undefined ? 1 : 2;
    if (value.kind === "error") return 1;
    if (value.kind === "diff" && this.#diffLayout === "split" && this.#previewWidth >= SPLIT_DIFF_MINIMUM_WIDTH) {
      const rows = parseUnifiedDiff(value.lines);
      if (rows !== undefined) return rows.length;
    }
    return value.lines.length;
  }

  #setPreviewScroll(next: number, height: number): void {
    const maximum = Math.max(0, this.#previewLineCount() - Math.max(1, height));
    const clamped = Math.max(0, Math.min(maximum, next));
    if (clamped === this.#previewScroll) return;
    this.#previewScroll = clamped;
    this.#changed();
  }

}
