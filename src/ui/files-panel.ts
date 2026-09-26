import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import {
  matchesKey,
  routeSgrMouseInput,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type SgrMouseEvent,
  type TUI,
} from "@oh-my-pi/pi-tui";
import {
  DEFAULT_DIFF_CONTEXT,
  DEFAULT_DIFF_LAYOUT,
  DEFAULT_DIFF_MASK_OPACITY,
  DEFAULT_TREE_RATIO,
  diffContextLabel,
  isDiffLayout,
  nextDiffContext,
  normalizeDiffContext,
  normalizeDiffMaskOpacity,
  TREE_MIN_COLUMNS,
  TREE_MIN_PREVIEW_COLUMNS,
  TREE_MIN_RATIO,
  type ChangeRecord,
  type ChangeScope,
  type CommitDiffPreview,
  type DiffLayout,
  type FilePreview,
  type GitBranch,
  type GitBranchSnapshot,
  type GitLogEntry,
  type GitLogSnapshot,
  type ProjectSnapshot,
  type ReviewSource,
  type ViewMode,
} from "../contracts";
import {
  buildChangeList,
  buildTree,
  flattenTree,
  recoverSelection,
  type TreeNode,
  type TreeRow,
  visiblePaths,
} from "../model/tree";
import {
  diffGutterWidth,
  parseUnifiedDiff,
  type DiffRow,
} from "./diff-view";
import {
  DEFAULT_HIGHLIGHT_THEME,
  getHighlightThemeLabel,
  HIGHLIGHT_THEMES,
  type Highlighter,
  type HighlighterStream,
  type HighlightThemeName,
} from "./highlight";
import {
  encodeOsc52,
  highlightSelection,
  isEmptySelection,
  selectionText,
  type PreviewSelection,
  type SelectionPoint,
} from "./selection";
import {
  fitCell,
  renderWrappedDiffLine,
  renderWrappedDiffSplitRow,
  renderHighlightedLine,
  renderNumberedLine,
  renderSelectedRow,
  renderSingleBorder,
  renderSingleRow,
  renderSplitBorder,
  renderSplitRow,
  sanitizeTerminalText,
  SPLIT_DIFF_MINIMUM_WIDTH,
} from "./render";
import { PANEL_HELP_GROUPS, panelPresentation, type PanelPresentationInput } from "./presentation";

export interface FilesPanelOptions {
  readonly cwd: string;
  readonly source: ReviewSource;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly sessionName?: string;
  /** Tree width restored from the persisted settings. */
  readonly treeRatio?: number;
  /** Reports every tree width change so the host can persist it. */
  readonly onTreeRatioChange?: (ratio: number) => void;
  /** Whether the tree pane opens hidden, restored from persisted settings. */
  readonly treeCollapsed?: boolean;
  /** Reports every tree collapse toggle so the host can persist it. */
  readonly onTreeCollapsedChange?: (collapsed: boolean) => void;
  /** Diff preview layout restored from persisted settings. */
  readonly diffLayout?: DiffLayout;
  /** Reports every diff layout change so the host can persist it. */
  readonly onDiffLayoutChange?: (layout: DiffLayout) => void;
  /** Diff context line count restored from persisted settings. */
  readonly diffContext?: number;
  /** Reports every diff context change so the host can persist it. */
  readonly onDiffContextChange?: (context: number) => void;
  /** Diff mask opacity restored from persisted settings (0–1). */
  readonly diffMaskOpacity?: number;
  readonly onDiffMaskOpacityChange?: (opacity: number) => void;
  /** Syntax palette restored from persisted settings. */
  readonly highlightTheme?: HighlightThemeName;
  /** Reports every syntax palette change so the host can persist it. */
  readonly onHighlightThemeChange?: (theme: HighlightThemeName) => void;
  /** Opens OMP's native /btw history above the review panel. */
  readonly onBtwHistory?: () => void;
  /** Colors text previews; previews render unstyled when omitted. */
  readonly highlight?: Highlighter;
  readonly done: (result: undefined) => void;
}

type PanelFocus = "tree" | "preview";

type LeftMode = "files" | "log" | "branches";

/**
 * How the left pane lists files: as a directory tree, or as the flat staged and
 * unstaged change list.
 */
type ListLayout = "tree" | "changes";

interface RenderCache {
  readonly width: number;
  readonly rows: number;
  readonly revision: number;
  readonly theme: Theme;
  readonly lines: readonly string[];
}
const EMPTY_CHANGES: ReadonlyMap<string, ChangeRecord> = new Map();

const WIDE_LAYOUT_MINIMUM = 80;

/** Rows moved or scrolled per mouse wheel notch. */
const WHEEL_STEP = 3;
/** Prefix of an SGR mouse report. */
const MOUSE_REPORT_PREFIX = "\x1b[<";

function errorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error)).replaceAll("\n", " ");
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

function pluralFiles(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}


export class FilesPanel implements Component {
  readonly #cwd: string;
  readonly #source: ReviewSource;
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #sessionName: string | undefined;
  readonly #onTreeRatioChange: ((ratio: number) => void) | undefined;
  readonly #onTreeCollapsedChange: ((collapsed: boolean) => void) | undefined;
  readonly #onDiffLayoutChange: ((layout: DiffLayout) => void) | undefined;
  readonly #onDiffContextChange: ((context: number) => void) | undefined;
  readonly #onHighlightThemeChange: ((theme: HighlightThemeName) => void) | undefined;
  readonly #onDiffMaskOpacityChange: ((opacity: number) => void) | undefined;
  readonly #onBtwHistory: (() => void) | undefined;
  #panelRows = 0;
  readonly #highlight: Highlighter | undefined;
  readonly #done: (result: undefined) => void;

  #leftMode: LeftMode = "files";
  #viewMode: ViewMode = "modified";
  #listLayout: ListLayout = "changes";
  #scope: ChangeScope = "workspace";
  #focus: PanelFocus = "tree";
  #snapshot: ProjectSnapshot | undefined;
  #rows: readonly TreeRow[] = [];
  #expanded = new Set<string>();
  #expansionInitialized = false;
  #selectedIndex = -1;
  #treeOffset = 0;
  #preview: FilePreview | undefined;
  #previewPath: string | undefined;
  #previewLoading = false;
  #history: GitLogSnapshot | undefined;
  #historyLoading = false;
  #historyError: string | undefined;
  #historyController: AbortController | undefined;
  #historyGeneration = 0;
  #logSelectedIndex = -1;
  #logOffset = 0;
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
  #refreshTimer: NodeJS.Timeout | undefined;
  #refreshQueued = false;
  #treeRatio: number;
  #treeCollapsed: boolean;
  #diffLayout: DiffLayout;
  #diffContext: number;
  #diffMaskOpacity: number;
  #highlightTheme: HighlightThemeName;
  #lastWidth = 0;
  #lastPreviewWidth = 0;
  #dividerDrag = false;
  /** Preview rows of the last render, before selection highlighting. */
  #previewRows: readonly string[] = [];
  #selection: PreviewSelection | undefined;
  #selectionDrag = false;
  #copyNotice: string | undefined;
  #diffRows: {
    readonly preview: FilePreview | CommitDiffPreview;
    readonly rows: readonly DiffRow[] | undefined;
  } | undefined;
  #wrappedDiff: {
    readonly preview: FilePreview | CommitDiffPreview;
    readonly width: number;
    readonly layout: DiffLayout;
    readonly lines: readonly string[];
  } | undefined;
  #highlighted: {
    readonly preview: FilePreview;
    readonly theme: HighlightThemeName;
    stream: HighlighterStream | undefined;
    readonly lines: string[];
    windowStart: number;
    windowEnd: number;
    windowLines: readonly string[] | undefined;
  } | undefined;
  #revision = 0;
  #cache: RenderCache | undefined;
  #started = false;
  #disposed = false;
  #doneCalled = false;
  #helpOpen = false;
  #branches: GitBranchSnapshot | undefined;
  #branchLoading = false;
  #branchError: string | undefined;
  #branchSelectedIndex = -1;
  #branchOffset = 0;
  #branchSwitching: string | undefined;
  #branchController: AbortController | undefined;
  #branchGeneration = 0;
  #switchController: AbortController | undefined;
  #switchGeneration = 0;

  constructor(options: FilesPanelOptions) {
    this.#cwd = options.cwd;
    this.#source = options.source;
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#keybindings = options.keybindings;
    this.#sessionName = options.sessionName;
    this.#onTreeRatioChange = options.onTreeRatioChange;
    this.#onTreeCollapsedChange = options.onTreeCollapsedChange;
    this.#onDiffLayoutChange = options.onDiffLayoutChange;
    this.#onDiffContextChange = options.onDiffContextChange;
    this.#onHighlightThemeChange = options.onHighlightThemeChange;
    this.#onDiffMaskOpacityChange = options.onDiffMaskOpacityChange;
    this.#onBtwHistory = options.onBtwHistory;
    this.#highlight = options.highlight;
    this.#treeRatio = Math.max(TREE_MIN_RATIO, options.treeRatio ?? DEFAULT_TREE_RATIO);
    this.#treeCollapsed = options.treeCollapsed ?? false;
    this.#focus = this.#treeCollapsed ? "preview" : "tree";
    this.#diffLayout = isDiffLayout(options.diffLayout) ? options.diffLayout : DEFAULT_DIFF_LAYOUT;
    this.#diffContext = normalizeDiffContext(options.diffContext) ?? DEFAULT_DIFF_CONTEXT;
    this.#diffMaskOpacity = normalizeDiffMaskOpacity(options.diffMaskOpacity) ?? DEFAULT_DIFF_MASK_OPACITY;
    this.#highlightTheme = options.highlightTheme ?? DEFAULT_HIGHLIGHT_THEME;
    this.#done = options.done;
  }

  start(): void {
    if (this.#started || this.#disposed || this.#doneCalled) return;
    this.#started = true;
    this.#queueRefresh();
  }

  handleInput(data: string): void {
    if (this.#disposed || this.#doneCalled) return;
    if (data.startsWith(MOUSE_REPORT_PREFIX)) {
      routeSgrMouseInput(data, event => this.#routeMouse(event));
      return;
    }
    const interrupted = this.#keybindings.matches(data, "app.interrupt");
    if (interrupted || matchesKey(data, "escape")) {
      if (this.#helpOpen) {
        this.#helpOpen = false;
        this.#requestRender();
        return;
      }
      if (this.#leftMode === "branches") {
        this.#leaveBranches();
        return;
      }
      if (this.#focus === "preview") {
        this.#focusTree();
      } else {
        this.#finish();
      }
      return;
    }
    if (data === "?") {
      this.#helpOpen = !this.#helpOpen;
      this.#requestRender();
      return;
    }
    if (this.#helpOpen) return;
    if (matchesKey(data, "i")) {
      this.#onBtwHistory?.();
      return;
    }
    if (matchesKey(data, "f5") || matchesKey(data, "r")) {
      // Queued rather than immediate: watching can have a refresh in flight.
      this.#queueRefresh();
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      if (this.#treeCollapsed) {
        this.#setTreeCollapsed(false);
        return;
      }
      this.#focus = this.#focus === "tree" ? "preview" : "tree";
      this.#requestRender();
      return;
    }
    if (matchesKey(data, "\\") || matchesKey(data, "ctrl+b")) {
      this.#setTreeCollapsed(!this.#treeCollapsed);
      return;
    }
    if (matchesKey(data, "d")) {
      this.#clearSelection();
      this.#diffLayout = this.#diffLayout === "unified" ? "split" : "unified";
      this.#onDiffLayoutChange?.(this.#diffLayout);
      this.#requestRender();
      return;
    }
    if (matchesKey(data, "c")) {
      this.#cycleDiffContext();
      return;
    }
    if (matchesKey(data, "-") || matchesKey(data, "=")) {
      const step = matchesKey(data, "=") ? 1 : -1;
      const next = Math.max(0, Math.min(1, Math.round(this.#diffMaskOpacity * 10 + step) / 10));
      if (next !== this.#diffMaskOpacity) {
        this.#diffMaskOpacity = next;
        this.#wrappedDiff = undefined;
        this.#onDiffMaskOpacityChange?.(next);
        this.#requestRender();
      }
      return;
    }
    if (matchesKey(data, "[") || matchesKey(data, "ctrl+left")) {
      this.#resizeTree(-1);
      return;
    }
    if (matchesKey(data, "]") || matchesKey(data, "ctrl+right")) {
      this.#resizeTree(1);
      return;
    }
    if (this.#highlight !== undefined && matchesKey(data, "t")) {
      const index = HIGHLIGHT_THEMES.findIndex(theme => theme.name === this.#highlightTheme);
      const nextTheme = HIGHLIGHT_THEMES[(index + 1) % HIGHLIGHT_THEMES.length];
      if (nextTheme === undefined) return;
      this.#highlightTheme = nextTheme.name;
      this.#highlighted = undefined;
      this.#onHighlightThemeChange?.(this.#highlightTheme);
      this.#requestRender();
      return;
    }
    if (matchesKey(data, "g")) {
      this.#toggleLeftMode();
      return;
    }
    if (matchesKey(data, "b")) {
      this.#toggleBranches();
      return;
    }

    if (this.#focus === "preview") {
      this.#handlePreviewInput(data);
      return;
    }
    this.#handleTreeInput(data);
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    this.#lastWidth = safeWidth;
    const reportedRows = Math.floor(this.#tui.terminal.rows);
    const terminalRows = Number.isFinite(reportedRows) ? Math.max(0, reportedRows) : 0;
    this.#panelRows = terminalRows;
    const cached = this.#cache;
    if (
      cached !== undefined &&
      cached.width === safeWidth &&
      cached.rows === terminalRows &&
      cached.revision === this.#revision &&
      cached.theme === this.#theme
    ) {
      return cached.lines;
    }
    let lines: readonly string[];
    if (this.#panelRows === 0) {
      lines = Object.freeze([]);
    } else if (this.#panelRows === 1) {
      lines = Object.freeze([this.#renderOverviewRow(safeWidth)]);
    } else if (this.#panelRows === 2) {
      lines = Object.freeze([
        this.#renderOverviewRow(safeWidth),
        renderSingleBorder(this.#footer(), safeWidth, "bottom", this.#theme),
      ]);
    } else if (this.#helpOpen) {
      lines = this.#renderHelp(safeWidth, this.#panelRows);
    } else {
      const contentHeight = this.#panelRows - 3;
      lines = this.#isWideLayout(safeWidth)
        ? this.#renderWide(safeWidth, contentHeight)
        : this.#renderNarrow(safeWidth, contentHeight);
    }
    const result = Object.freeze([...lines]);
    this.#cache = {
      width: safeWidth,
      rows: terminalRows,
      revision: this.#revision,
      theme: this.#theme,
      lines: result,
    };
    return result;
  }

  invalidate(): void {
    if (this.#disposed) return;
    this.#revision += 1;
    this.#cache = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dividerDrag = false;
    this.#selectionDrag = false;
    this.#selection = undefined;
    this.#copyNotice = undefined;
    this.#previewRows = [];
    this.#refreshGeneration += 1;
    this.#previewGeneration += 1;
    this.#historyGeneration += 1;
    this.#commitDiffGeneration += 1;
    this.#watchGeneration += 1;
    if (this.#refreshTimer !== undefined) {
      clearTimeout(this.#refreshTimer);
    }
    this.#refreshTimer = undefined;
    this.#refreshQueued = false;
    this.#refreshController?.abort();
    this.#previewController?.abort();
    this.#historyController?.abort();
    this.#commitDiffController?.abort();
    this.#watchController?.abort();
    this.#branchController?.abort();
    this.#switchController?.abort();
    this.#refreshController = undefined;
    this.#previewController = undefined;
    this.#historyController = undefined;
    this.#commitDiffController = undefined;
    this.#watchController = undefined;
    this.#branchController = undefined;
    this.#switchController = undefined;
    this.#highlighted = undefined;
    this.#diffRows = undefined;
    this.#cache = undefined;
  }

  #handleTreeInput(data: string): void {
    if (this.#leftMode === "branches") {
      if (matchesKey(data, "up") || data === "p") {
        this.#moveBranchSelection(-1);
        return;
      }
      if (matchesKey(data, "down") || data === "n") {
        this.#moveBranchSelection(1);
        return;
      }
      if (matchesKey(data, "enter")) {
        this.#activateSelectedBranch();
      }
      return;
    }
    if (this.#leftMode === "log") {
      if (matchesKey(data, "up") || data === "p") {
        this.#moveLogSelection(-1);
        return;
      }
      if (matchesKey(data, "down") || data === "n") {
        this.#moveLogSelection(1);
        return;
      }
      if (
        matchesKey(data, "enter")
        || matchesKey(data, "right")
        || matchesKey(data, "l")
      ) {
        this.#focus = "preview";
        this.#requestRender();
      }
      return;
    }
    if (matchesKey(data, "a")) {
      if (this.#snapshot?.kind === "git" && (this.#viewMode !== "all" || this.#listLayout !== "tree")) {
        this.#viewMode = "all";
        this.#listLayout = "tree";
        this.#rebuildRows();
        this.#requestRender();
      }
      return;
    }
    if (matchesKey(data, "m")) {
      if (this.#snapshot?.kind === "git" && this.#viewMode !== "modified") {
        this.#viewMode = "modified";
        this.#rebuildRows();
        this.#requestRender();
      }
      return;
    }
    if (matchesKey(data, "v")) {
      // The change list has nothing to show outside a repository, so the key is
      // inert on the filesystem fallback, like m and a.
      if (this.#snapshot?.kind === "git") {
        this.#listLayout = this.#listLayout === "changes" ? "tree" : "changes";
        this.#rebuildRows();
        this.#requestRender();
      }
      return;
    }
    if (matchesKey(data, "s")) {
      if (this.#snapshot?.kind === "git") {
        this.#scope = this.#scope === "workspace" ? "session" : "workspace";
        this.#rebuildRows();
        this.#requestRender();
      }
      return;
    }
    if (matchesKey(data, "up") || data === "p") {
      this.#moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "n") {
      this.#moveSelection(1);
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.#collapseOrParent();
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "l")) {
      // A file has nothing to expand, so the key crosses into the preview;
      // a directory keeps the familiar expand/descend behavior.
      if (this.#selectedRow()?.node.kind === "file") this.#focusPreview();
      else this.#expandOrChild();
      return;
    }
    if (matchesKey(data, "enter")) this.#openSelection();
  }

  /** Return to the tree, revealing it first when it is collapsed. */
  #focusTree(): void {
    if (this.#treeCollapsed) {
      this.#setTreeCollapsed(false);
      return;
    }
    this.#focus = "tree";
    this.#requestRender();
  }

  /** Move the operating focus to the preview pane. */
  #focusPreview(): void {
    if (this.#focus === "preview") return;
    this.#focus = "preview";
    this.#requestRender();
  }

  #setTreeCollapsed(collapsed: boolean): void {
    if (this.#treeCollapsed === collapsed) return;
    this.#clearSelection();
    this.#treeCollapsed = collapsed;
    // A hidden tree cannot hold focus, and revealing it hands focus back.
    this.#focus = collapsed ? "preview" : "tree";
    this.#onTreeCollapsedChange?.(collapsed);
    this.#requestRender();
  }

  /**
   * Widen the unchanged context Git prints around each hunk, up to the whole
   * file. The diff itself comes from Git, so the preview is refetched.
   */
  #cycleDiffContext(): void {
    this.#clearSelection();
    this.#diffContext = nextDiffContext(this.#diffContext);
    this.#onDiffContextChange?.(this.#diffContext);
    if (this.#leftMode === "log") {
      const entry = this.#selectedLogEntry();
      if (entry !== undefined) this.#beginCommitDiff(entry.oid, true);
    } else if (this.#previewPath !== undefined) {
      this.#beginPreview(this.#previewPath, true);
    }
    this.#requestRender();
  }

  #handlePreviewInput(data: string): void {
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.#focusTree();
      return;
    }
    const height = this.#previewViewportHeight();
    if (matchesKey(data, "home")) {
      this.#setPreviewScroll(0, height);
    } else if (matchesKey(data, "end")) {
      this.#setPreviewScroll(Number.MAX_SAFE_INTEGER, height);
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.#setPreviewScroll(this.#previewScroll - 1, height);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.#setPreviewScroll(this.#previewScroll + 1, height);
    } else if (matchesKey(data, "pageUp")) {
      this.#setPreviewScroll(this.#previewScroll - height, height);
    } else if (matchesKey(data, "pageDown")) {
      this.#setPreviewScroll(this.#previewScroll + height, height);
    }
  }

  /**
   * Route a decoded mouse report: wheel scrolls the pane under the pointer and
   * a left press on the wide-layout divider starts a width drag.
   */
  #routeMouse(event: SgrMouseEvent): boolean {
    const wide = this.#isWideLayout(this.#lastWidth);
    const treeWidth = this.#treeWidth(this.#lastWidth);
    if (event.release) {
      if (this.#selectionDrag) this.#copySelection();
      this.#selectionDrag = false;
      this.#dividerDrag = false;
      return true;
    }
    if (event.wheel !== null) {
      const overTree = wide ? event.col <= treeWidth : this.#focus === "tree";
      if (overTree) this.#moveSelection(event.wheel * WHEEL_STEP);
      else this.#setPreviewScroll(this.#previewScroll + event.wheel * WHEEL_STEP, this.#previewViewportHeight());
      return true;
    }
    if (event.leftClick) {
      this.#dividerDrag = wide && event.col === treeWidth + 1;
      this.#clearSelection();
      if (this.#dividerDrag) return true;
      const treeRow = this.#treeClickRow(event, wide, treeWidth);
      if (treeRow !== undefined) {
        this.#selectTreeRow(treeRow);
        return true;
      }
      const point = this.#previewPoint(event, wide, treeWidth);
      if (point === undefined) return true;
      // A press inside the preview both takes focus and anchors a text drag.
      this.#focusPreview();
      this.#selectionDrag = true;
      this.#selection = { anchor: point, head: point };
      this.#requestRender();
      return true;
    }
    const point = this.#previewPoint(event, wide, treeWidth);
    // Motion with the left button held (low button bits clear) is a drag.
    if (event.motion && (event.button & 3) === 0) {
      if (this.#dividerDrag && wide) {
        this.#setTreeColumns(event.col - 1);
        return true;
      }
      const selection = this.#selection;
      if (this.#selectionDrag && selection !== undefined && point !== undefined) {
        if (selection.head.row === point.row && selection.head.col === point.col) return true;
        this.#selection = { anchor: selection.anchor, head: point };
        this.#requestRender();
      }
    }
    return true;
  }

  /**
   * Translate a mouse report into preview-pane coordinates, or `undefined` when
   * the pointer is outside the preview content area.
   */
  #previewPoint(event: SgrMouseEvent, wide: boolean, treeWidth: number): SelectionPoint | undefined {
    const terminalRows = this.#panelRows;
    if (terminalRows <= 3) return undefined;
    // Rows 0-1 are the overview and pane-title borders; the last row is the footer border.
    const row = event.row - 2;
    if (row < 0 || row >= terminalRows - 3) return undefined;
    const previewWidth = wide
      ? Math.max(0, this.#lastWidth - 3 - treeWidth)
      : Math.max(0, this.#lastWidth - 2);
    if (previewWidth === 0) return undefined;
    if (wide) {
      const col = event.col - treeWidth - 2;
      return col < 0 || col >= previewWidth ? undefined : { row, col };
    }
    if (this.#focus !== "preview") return undefined;
    const col = event.col - 1;
    return col < 0 || col >= previewWidth ? undefined : { row, col };
  }

  /**
   * Translate a mouse report into an absolute row of the active left-pane
   * list, or `undefined` when the pointer is outside the tree/log/branches
   * content area.
   */
  #treeClickRow(event: SgrMouseEvent, wide: boolean, treeWidth: number): number | undefined {
    const terminalRows = this.#panelRows;
    if (terminalRows <= 3) return undefined;
    const height = terminalRows - 3;
    const row = event.row - 2;
    if (row < 0 || row >= height) return undefined;
    if (wide) {
      if (event.col < 1 || event.col > treeWidth) return undefined;
    } else if (this.#focus === "preview") {
      return undefined;
    }
    this.#syncListOffset(height);
    const offset = this.#leftMode === "branches"
      ? this.#branchOffset
      : this.#leftMode === "log"
        ? this.#logOffset
        : this.#treeOffset;
    return offset + row;
  }

  /** Recompute the active list's viewport offset outside of a render pass. */
  #syncListOffset(height: number): void {
    if (this.#leftMode === "branches") {
      if (this.#branchSelectedIndex < this.#branchOffset) this.#branchOffset = this.#branchSelectedIndex;
      if (this.#branchSelectedIndex >= this.#branchOffset + height) this.#branchOffset = this.#branchSelectedIndex - height + 1;
      return;
    }
    if (this.#leftMode === "log") {
      if (this.#logSelectedIndex < this.#logOffset) this.#logOffset = this.#logSelectedIndex;
      if (this.#logSelectedIndex >= this.#logOffset + height) this.#logOffset = this.#logSelectedIndex - height + 1;
      return;
    }
    if (this.#selectedIndex < this.#treeOffset) this.#treeOffset = this.#selectedIndex;
    if (this.#selectedIndex >= this.#treeOffset + height) this.#treeOffset = this.#selectedIndex - height + 1;
  }

  #selectTreeRow(rowIndex: number): void {
    if (this.#leftMode === "branches") {
      const branches = this.#branches?.branches;
      if (branches === undefined || rowIndex < 0 || rowIndex >= branches.length) return;
      this.#focus = "tree";
      if (rowIndex === this.#branchSelectedIndex) {
        this.#requestRender();
        return;
      }
      this.#branchSelectedIndex = rowIndex;
      this.#requestRender();
      return;
    }
    if (this.#leftMode === "log") {
      const entries = this.#history?.entries;
      if (entries === undefined || rowIndex < 0 || rowIndex >= entries.length) return;
      this.#focus = "tree";
      if (rowIndex === this.#logSelectedIndex) {
        this.#requestRender();
        return;
      }
      this.#logSelectedIndex = rowIndex;
      this.#previewScroll = 0;
      const entry = entries[rowIndex];
      if (entry !== undefined) this.#beginCommitDiff(entry.oid);
      this.#requestRender();
      return;
    }
    if (rowIndex < 0 || rowIndex >= this.#rows.length) return;
    this.#focus = "tree";
    if (rowIndex === this.#selectedIndex) {
      this.#requestRender();
      return;
    }
    this.#selectedIndex = rowIndex;
    this.#selectionChanged();
  }

  #clearSelection(): void {
    this.#selectionDrag = false;
    if (this.#selection === undefined && this.#copyNotice === undefined) return;
    this.#selection = undefined;
    this.#copyNotice = undefined;
    this.#requestRender();
  }

  /** Copy the dragged text with OSC 52 and report the result in the footer. */
  #copySelection(): void {
    const selection = this.#selection;
    if (selection === undefined || isEmptySelection(selection)) return;
    const text = selectionText(this.#previewRows, selection, this.#lastPreviewWidth);
    if (text.length === 0) return;
    try {
      this.#tui.terminal.write(encodeOsc52(text));
    } catch {
      this.#copyNotice = "copy failed";
      this.#requestRender();
      return;
    }
    const lines = text.split("\n").length;
    this.#copyNotice = `copied ${lines} ${lines === 1 ? "line" : "lines"}`;
    this.#requestRender();
  }

  /** Whether both panes are shown: the panel is wide enough and the tree is out. */
  #isWideLayout(width: number): boolean {
    return !this.#treeCollapsed && width >= WIDE_LAYOUT_MINIMUM;
  }

  /** Tree pane columns for a panel width, reserving usable preview space. */
  #treeWidth(width: number): number {
    const available = Math.max(0, Math.floor(width) - 3);
    const maximum = Math.max(0, available - TREE_MIN_PREVIEW_COLUMNS);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    return Math.max(minimum, Math.min(maximum, Math.round(available * this.#treeRatio)));
  }

  #resizeTree(deltaColumns: number): void {
    // Widening a collapsed tree brings it back; narrowing it further is a no-op.
    if (this.#treeCollapsed) {
      if (deltaColumns > 0) this.#setTreeCollapsed(false);
      return;
    }
    // The single-pane layout has no divider: the tree pane spans the panel and
    // the stored width is not consulted. Resizing there would only rewrite the
    // persisted ratio, changing the pane width behind the user's back for the
    // next terminal wide enough to show both panes.
    if (!this.#isWideLayout(this.#lastWidth)) return;
    this.#setTreeColumns(this.#treeWidth(this.#lastWidth) + deltaColumns);
  }

  #setTreeColumns(columns: number): void {
    const available = Math.max(0, this.#lastWidth - 3);
    if (available === 0) return;
    const maximum = Math.max(0, available - TREE_MIN_PREVIEW_COLUMNS);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(columns)));
    if (clamped === this.#treeWidth(this.#lastWidth)) return;
    this.#clearSelection();
    this.#treeRatio = clamped / available;
    this.#onTreeRatioChange?.(this.#treeRatio);
    this.#requestRender();
  }

  #previewViewportHeight(): number {
    return Math.max(1, Math.max(4, this.#panelRows || Math.floor(this.#tui.terminal.rows)) - 3);
  }

  #queueRefresh(debounce = false): void {
    if (this.#disposed || this.#doneCalled) return;
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
    if (this.#disposed || this.#doneCalled) return;
    if (this.#refreshController !== undefined) {
      this.#refreshQueued = true;
      return;
    }
    this.#beginRefresh();
  }

  #beginRefresh(): void {
    if (this.#disposed || this.#doneCalled || this.#refreshController !== undefined) return;
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
    this.#requestRender();

    void this.#source.refresh({ signal: controller.signal }).then(
      project => {
        if (!this.#isCurrentRefresh(generation, controller)) return;
        this.#refreshController = undefined;
        this.#refreshLoading = false;
        this.#snapshot = project;
        if (project.kind === "git") {
          this.#installWatch();
          if (this.#leftMode === "log") this.#beginHistory();
          else this.#rebuildRows(true);
        } else {
          this.#stopWatch();
          if (this.#leftMode === "log") this.#leftMode = "files";
          this.#rebuildRows(true);
        }
        this.#requestRender();
        this.#runCoalescedRefresh();
      },
      error => {
        if (!this.#isCurrentRefresh(generation, controller) || isAbort(error, controller.signal)) return;
        this.#refreshController = undefined;
        this.#refreshLoading = false;
        this.#refreshError = errorMessage(error);
        this.#requestRender();
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
    this.#watchError = errorMessage(error);
    this.#requestRender();
  }

  #toggleLeftMode(): void {
    if (this.#snapshot?.kind !== "git") return;
    if (this.#treeCollapsed) this.#setTreeCollapsed(false);
    else this.#focus = "tree";
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
    this.#requestRender();
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
        this.#logOffset = Math.min(this.#logOffset, Math.max(0, history.entries.length - 1));
        const entry = this.#selectedLogEntry();
        if (entry !== undefined) this.#beginCommitDiff(entry.oid);
        else this.#cancelCommitDiff();
        this.#requestRender();
      },
      error => {
        if (!this.#isCurrentHistory(generation, controller) || isAbort(error, controller.signal)) return;
        this.#historyController = undefined;
        this.#historyLoading = false;
        this.#historyError = errorMessage(error);
        this.#requestRender();
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
    this.#requestRender();
  }

  #selectedLogEntry(): GitLogEntry | undefined {
    return this.#logSelectedIndex < 0 ? undefined : this.#history?.entries[this.#logSelectedIndex];
  }

  #beginCommitDiff(oid: string, force = false): void {
    if (
      this.#disposed
      || (!force && this.#commitDiff?.oid === oid && (this.#commitDiffLoading || this.#commitDiff !== undefined))
    ) return;
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
        this.#requestRender();
      },
      error => {
        if (!this.#isCurrentCommitDiff(generation, controller, oid) || isAbort(error, controller.signal)) return;
        this.#commitDiffController = undefined;
        this.#commitDiffLoading = false;
        this.#commitDiff = { oid, kind: "error", lines: [], truncated: false, error: errorMessage(error) };
        this.#requestRender();
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

  #toggleBranches(): void {
    if (this.#leftMode === "branches") {
      this.#leaveBranches();
      return;
    }
    this.#enterBranches();
  }

  #enterBranches(): void {
    if (this.#disposed || this.#snapshot?.kind !== "git") return;
    this.#leftMode = "branches";
    if (this.#treeCollapsed) this.#setTreeCollapsed(false);
    else this.#focus = "tree";
    this.#previewScroll = 0;
    this.#cancelPreview();
    this.#cancelHistory();
    this.#cancelCommitDiff();
    this.#beginBranches();
    this.#requestRender();
  }

  #leaveBranches(): void {
    this.#leftMode = "files";
    this.#cancelBranches();
    this.#rebuildRows(true);
    this.#requestRender();
  }

  #beginBranches(): void {
    if (this.#disposed || this.#leftMode !== "branches") return;
    const generation = ++this.#branchGeneration;
    this.#branchController?.abort();
    const controller = new AbortController();
    this.#branchController = controller;
    this.#branchLoading = true;
    this.#branchError = undefined;
    void this.#source.branches({ signal: controller.signal }).then(
      snapshot => {
        if (!this.#isCurrentBranches(generation, controller)) return;
        this.#branchController = undefined;
        this.#branchLoading = false;
        this.#branches = snapshot;
        const currentIndex = snapshot.branches.findIndex(branch => branch.current);
        this.#branchSelectedIndex = snapshot.branches.length === 0 ? -1 : Math.max(0, currentIndex);
        this.#branchOffset = 0;
        this.#requestRender();
      },
      error => {
        if (!this.#isCurrentBranches(generation, controller) || isAbort(error, controller.signal)) return;
        this.#branchController = undefined;
        this.#branchLoading = false;
        this.#branchError = errorMessage(error);
        this.#requestRender();
      },
    );
  }

  #isCurrentBranches(generation: number, controller: AbortController): boolean {
    return !this.#disposed
      && this.#leftMode === "branches"
      && generation === this.#branchGeneration
      && this.#branchController === controller;
  }

  #cancelBranches(): void {
    this.#branchGeneration += 1;
    this.#branchController?.abort();
    this.#branchController = undefined;
    this.#branchLoading = false;
  }

  #moveBranchSelection(delta: number): void {
    const branches = this.#branches?.branches;
    if (branches === undefined || branches.length === 0) return;
    const next = Math.max(0, Math.min(branches.length - 1, this.#branchSelectedIndex + delta));
    if (next === this.#branchSelectedIndex) return;
    this.#branchSelectedIndex = next;
    this.#requestRender();
  }

  #selectedBranch(): GitBranch | undefined {
    const branches = this.#branches?.branches;
    return branches === undefined || this.#branchSelectedIndex < 0
      ? undefined
      : branches[this.#branchSelectedIndex];
  }

  #activateSelectedBranch(): void {
    if (this.#branchSwitching !== undefined) return;
    const selected = this.#selectedBranch();
    if (selected === undefined || selected.current) return;
    this.#beginSwitchBranch(selected.name);
  }

  #beginSwitchBranch(name: string): void {
    this.#branchSwitching = name;
    this.#branchError = undefined;
    this.#clearSelection();
    this.#previewGeneration += 1;
    this.#previewController?.abort();
    this.#previewController = undefined;
    this.#previewLoading = false;
    this.#historyGeneration += 1;
    this.#historyController?.abort();
    this.#historyController = undefined;
    this.#historyLoading = false;
    this.#commitDiffGeneration += 1;
    this.#commitDiffController?.abort();
    this.#commitDiffController = undefined;
    this.#commitDiffLoading = false;
    this.#refreshGeneration += 1;
    this.#refreshController?.abort();
    this.#refreshController = undefined;
    this.#refreshLoading = false;
    this.#stopWatch();
    const generation = ++this.#switchGeneration;
    const controller = new AbortController();
    this.#switchController = controller;
    this.#requestRender();
    void this.#source.switchBranch(name, { signal: controller.signal }).then(
      () => {
        if (!this.#isCurrentSwitch(generation, controller)) return;
        this.#switchController = undefined;
        this.#branchSwitching = undefined;
        this.#leftMode = "files";
        this.#focus = "tree";
        this.#treeOffset = 0;
        this.#cancelBranches();
        this.#beginRefresh();
        this.#requestRender();
      },
      error => {
        if (!this.#isCurrentSwitch(generation, controller) || isAbort(error, controller.signal)) return;
        this.#switchController = undefined;
        this.#branchSwitching = undefined;
        this.#branchError = errorMessage(error);
        this.#installWatch();
        this.#requestRender();
      },
    );
  }

  #isCurrentSwitch(generation: number, controller: AbortController): boolean {
    return !this.#disposed && generation === this.#switchGeneration && this.#switchController === controller;
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
      this.#treeOffset = Math.min(this.#treeOffset, Math.max(0, this.#rows.length - 1));
      const selectedChange = this.#selectedRow();
      if (selectedChange?.node.kind === "file") {
        this.#beginPreview(selectedChange.node.path, forcePreview);
      } else this.#cancelPreview();
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
    this.#treeOffset = Math.min(this.#treeOffset, Math.max(0, this.#rows.length - 1));
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

  #moveSelection(delta: number): void {
    if (this.#leftMode === "branches") {
      this.#moveBranchSelection(delta);
      return;
    }
    if (this.#leftMode === "log") {
      this.#moveLogSelection(delta);
      return;
    }
    if (this.#rows.length === 0) return;
    const clamped = Math.max(0, Math.min(this.#rows.length - 1, this.#selectedIndex + delta));
    const next = this.#skipSections(clamped, delta < 0 ? -1 : 1);
    if (next < 0 || next === this.#selectedIndex) return;
    this.#selectedIndex = next;
    this.#selectionChanged();
  }

  #selectionChanged(): void {
    this.#previewScroll = 0;
    const selected = this.#selectedRow();
    if (selected?.node.kind === "file") this.#beginPreview(selected.node.path);
    else this.#cancelPreview();
    this.#requestRender();
  }

  #collapseOrParent(): void {
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

  #expandOrChild(): void {
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

  #visiblePaths(): readonly string[] {
    const project = this.#snapshot;
    if (project === undefined) return [];
    const mode: ViewMode = project.kind === "filesystem" ? "all" : this.#viewMode;
    return visiblePaths(project.allFiles, this.#activeChanges(), mode);
  }

  #openSelection(): void {
    if (this.#leftMode === "log") {
      if (this.#selectedLogEntry() !== undefined) {
        this.#focus = "preview";
        this.#requestRender();
      }
      return;
    }
    const selected = this.#selectedRow();
    if (selected === undefined) return;
    if (selected.node.kind === "directory") {
      if (selected.expanded) this.#collapseOrParent();
      else this.#expandOrChild();
      return;
    }
    this.#beginPreview(selected.node.path);
    if (this.#focus !== "preview") {
      this.#focus = "preview";
      this.#requestRender();
    }
  }

  #beginPreview(path: string, force = false): void {
    if (this.#disposed || (!force && this.#previewPath === path && (this.#previewLoading || this.#preview !== undefined))) {
      return;
    }
    const samePath = this.#previewPath === path;
    this.#clearSelection();
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
        this.#requestRender();
      },
      error => {
        if (!this.#isCurrentPreview(generation, controller, path) || isAbort(error, controller.signal)) return;
        this.#previewController = undefined;
        this.#previewLoading = false;
        this.#preview = { path, kind: "error", lines: [], truncated: false, error: errorMessage(error) };
        this.#requestRender();
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
    this.#clearSelection();
    this.#previewGeneration += 1;
    this.#previewController?.abort();
    this.#previewController = undefined;
    this.#previewPath = undefined;
    this.#preview = undefined;
    this.#previewLoading = false;
    this.#previewScroll = 0;
    this.#highlighted = undefined;
    this.#diffRows = undefined;
  }

  #setPreviewScroll(next: number, height: number): void {
    const maximum = Math.max(0, this.#previewLineCount() - height);
    const clamped = Math.max(0, Math.min(maximum, next));
    if (clamped === this.#previewScroll) return;
    this.#previewScroll = clamped;
    // The selection is anchored to viewport rows, so scrolling retires it.
    this.#clearSelection();
    this.#requestRender();
  }

  #previewLineCount(): number {
    const terminalWidth = Math.max(1, Math.floor(this.#tui.terminal.columns));
    const width = this.#lastPreviewWidth > 0
      ? this.#lastPreviewWidth
      : this.#isWideLayout(terminalWidth)
        ? terminalWidth - 3 - this.#treeWidth(terminalWidth)
        : terminalWidth - 2;
    if (this.#leftMode === "log") {
      const commit = this.#commitDiff;
      return commit === undefined || commit.kind === "error" ? 1 : this.#diffVisualRows(commit, width).length;
    }
    const value = this.#preview;
    if (value === undefined) return 1;
    if (value.kind === "binary") return value.byteSize === undefined ? 1 : 2;
    if (value.kind === "error") return 1;
    return value.kind === "diff"
      ? this.#diffVisualRows(value, width).length
      : value.lines.length;
  }

  #diffVisualRows(value: FilePreview | CommitDiffPreview, width: number): readonly string[] {
    const cached = this.#wrappedDiff;
    if (cached?.preview === value && cached.width === width && cached.layout === this.#diffLayout) {
      return cached.lines;
    }
    const rows = this.#splitDiffRows(value, width);
    let lines: readonly string[];
    if (rows === undefined) {
      lines = value.lines.flatMap(line => renderWrappedDiffLine(line, width, this.#theme, this.#diffMaskOpacity));
    } else {
      const gutter = diffGutterWidth(rows);
      lines = rows.flatMap(row => renderWrappedDiffSplitRow(row, width, this.#theme, gutter, this.#diffMaskOpacity));
    }
    this.#wrappedDiff = { preview: value, width, layout: this.#diffLayout, lines };
    return lines;
  }

  #splitDiffRows(value: FilePreview | CommitDiffPreview, width: number): readonly DiffRow[] | undefined {
    if (this.#diffLayout !== "split" || value.kind !== "diff") return undefined;
    if (width < SPLIT_DIFF_MINIMUM_WIDTH) return undefined;
    let cached = this.#diffRows;
    if (cached?.preview !== value) {
      cached = { preview: value, rows: parseUnifiedDiff(value.lines) };
      this.#diffRows = cached;
    }
    return cached.rows;
  }


  #requestRender(): void {
    if (this.#disposed || this.#doneCalled) return;
    this.#revision += 1;
    this.#cache = undefined;
    this.#tui.requestRender();
  }

  #finish(): void {
    if (this.#doneCalled) return;
    this.#doneCalled = true;
    this.dispose();
    this.#done(undefined);
  }

  #renderWide(width: number, height: number): readonly string[] {
    const leftWidth = this.#treeWidth(width);
    const rightWidth = Math.max(0, width - 3 - leftWidth);
    const tree = this.#renderTreeRows(leftWidth, height);
    const preview = this.#renderPreviewRows(rightWidth, height);
    const result: string[] = [
      this.#renderOverviewRow(width),
      renderSplitBorder(this.#treeTitle(), this.#previewTitle(), width, leftWidth, "top", this.#theme),
    ];
    for (let index = 0; index < height; index += 1) {
      result.push(renderSplitRow(tree[index] ?? "", preview[index] ?? "", width, leftWidth, this.#theme));
    }
    result.push(renderSingleBorder(this.#footer(), width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #renderNarrow(width: number, height: number): readonly string[] {
    const previewFocused = this.#focus === "preview";
    const bodyWidth = Math.max(0, width - 2);
    const body = previewFocused
      ? this.#renderPreviewRows(bodyWidth, height)
      : this.#renderTreeRows(bodyWidth, height);
    const result: string[] = [
      this.#renderOverviewRow(width),
      renderSingleBorder(previewFocused ? this.#previewTitle() : this.#treeTitle(), width, "top", this.#theme),
    ];
    for (let index = 0; index < height; index += 1) {
      result.push(renderSingleRow(body[index] ?? "", width, this.#theme));
    }
    result.push(renderSingleBorder(this.#footer(), width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #presentationInput(): PanelPresentationInput {
    const snapshot = this.#snapshot;
    const selectedRow = this.#leftMode === "files" ? this.#selectedRow() : undefined;
    const selectedPath = this.#leftMode === "log"
      ? this.#selectedLogEntry()?.shortOid
      : this.#leftMode === "files"
        ? (this.#previewPath ?? (selectedRow?.node.kind === "file" ? selectedRow.node.path : undefined))
        : undefined;
    const selectedSummary = this.#leftMode === "files" && selectedPath !== undefined && snapshot?.kind === "git"
      ? snapshot.workspaceSummaryByPath.get(selectedPath)
      : undefined;
    const fileCount = snapshot === undefined
      ? 0
      : snapshot.kind === "filesystem"
        ? snapshot.allFiles.length
        : this.#scope === "workspace"
          ? snapshot.workspaceSummary.files
          : snapshot.sessionSummary.files;
    const currentBranch = snapshot?.kind === "git" ? snapshot.currentBranch : undefined;
    const detachedAt = snapshot?.kind === "git" ? snapshot.detachedAt : undefined;
    return {
      sourceKind: snapshot?.kind,
      leftMode: this.#leftMode,
      focus: this.#focus,
      viewMode: this.#viewMode,
      scope: this.#scope,
      ...(currentBranch !== undefined ? { currentBranch } : {}),
      ...(detachedAt !== undefined ? { detachedAt } : {}),
      fileCount,
      ...(selectedPath !== undefined ? { selectedPath } : {}),
      ...(selectedSummary !== undefined ? { selectedSummary } : {}),
    };
  }

  #renderOverviewRow(width: number): string {
    const presentation = panelPresentation(this.#presentationInput());
    const titleWidth = visibleWidth(presentation.overviewTitle);
    const metaWidth = visibleWidth(presentation.overviewMeta);
    const interior = Math.max(0, width - 2);
    const gap = Math.max(1, interior - titleWidth - metaWidth);
    const content = `${presentation.overviewTitle}${" ".repeat(gap)}${presentation.overviewMeta}`;
    return renderSingleRow(content, width, this.#theme);
  }

  #renderHelp(width: number, terminalRows: number): readonly string[] {
    const height = Math.max(0, terminalRows - 2);
    const body: string[] = [];
    for (const group of PANEL_HELP_GROUPS) {
      body.push(group.title);
      for (const action of group.actions) body.push(`  ${action.key}  ${action.label}`);
    }
    const result: string[] = [renderSingleBorder("Keyboard shortcuts", width, "top", this.#theme)];
    for (let index = 0; index < height; index += 1) {
      result.push(renderSingleRow(body[index] ?? "", width, this.#theme));
    }
    result.push(renderSingleBorder(this.#footer(), width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #treeTitle(): string {
    if (this.#leftMode === "branches") return "Branches";
    if (this.#leftMode === "log") return "History";
    // The redesign names the pane "Files"; the listing and scope detail lives in the overview
    // header and the footer instead of the pane title.
    return "Files";
  }

  #previewTitle(): string {
    if (this.#leftMode === "branches") return "Preview";
    if (this.#leftMode === "log") {
      const entry = this.#selectedLogEntry();
      if (entry === undefined) return "Commit preview";
      if (this.#commitDiffLoading) return `Loading commit: ${entry.shortOid}`;
      return this.#commitDiff?.kind === "error" ? `Error: ${entry.shortOid}` : `Commit: ${entry.shortOid}`;
    }
    const selected = this.#selectedRow();
    const path = this.#previewPath ?? (selected?.node.kind === "file" ? selected.node.path : undefined);
    if (path === undefined) return "Preview";
    if (this.#previewLoading) return `Loading: ${path}`;
    switch (this.#preview?.kind) {
      case "diff":
        return `Diff: ${path}`;
      case "binary":
        return `Binary: ${path}`;
      case "error":
        return `Error: ${path}`;
      default:
        return `File: ${path}`;
    }
  }

  #renderTreeRows(width: number, height: number): readonly string[] {
    if (this.#leftMode === "branches") return this.#renderBranchRows(width, height);
    if (this.#leftMode === "log") return this.#renderLogRows(width, height);
    if (this.#snapshot === undefined) {
      const message = this.#refreshError === undefined ? "Loading project files…" : `Error: ${this.#refreshError}`;
      return [this.#theme.fg(this.#refreshError === undefined ? "accent" : "error", message)];
    }
    if (this.#rows.length === 0) {
      const message = this.#snapshot.kind === "filesystem"
        ? "No project files found"
        : this.#usesChangeList()
          ? `No ${this.#scope} changes — press v for the file tree`
          : this.#viewMode === "modified"
            ? `No ${this.#scope} changes — press a for all files`
            : "No project files found";
      return [this.#theme.fg("muted", message)];
    }
    if (this.#selectedIndex < this.#treeOffset) this.#treeOffset = this.#selectedIndex;
    if (this.#selectedIndex >= this.#treeOffset + height) this.#treeOffset = this.#selectedIndex - height + 1;
    const visible = this.#rows.slice(this.#treeOffset, this.#treeOffset + height);
    return visible.map((row, offset) => this.#renderTreeRow(row, this.#treeOffset + offset, width));
  }

  #renderLogRows(width: number, height: number): readonly string[] {
    if (this.#historyLoading && this.#history === undefined) return [this.#theme.fg("accent", "Loading history…")];
    if (this.#historyError !== undefined) return [this.#theme.fg("error", `Error: ${this.#historyError}`)];
    const entries = this.#history?.entries;
    if (entries === undefined || entries.length === 0) return [this.#theme.fg("muted", "No commits found")];
    if (this.#logSelectedIndex < this.#logOffset) this.#logOffset = this.#logSelectedIndex;
    if (this.#logSelectedIndex >= this.#logOffset + height) this.#logOffset = this.#logSelectedIndex - height + 1;
    return entries
      .slice(this.#logOffset, this.#logOffset + height)
      .map((entry, offset) => this.#renderLogRow(entry, this.#logOffset + offset, width));
  }

  #renderLogRow(entry: GitLogEntry, index: number, width: number): string {
    const selected = index === this.#logSelectedIndex;
    const raw = `${selected ? ">" : " "} ${sanitizeTerminalText(entry.shortOid).replaceAll("\n", " ")} ${sanitizeTerminalText(entry.subject).replaceAll("\n", " ")}`;
    if (selected && this.#focus === "tree") return renderSelectedRow(raw, width, this.#theme);
    return this.#theme.fg("text", fitCell(raw, width));
  }

  #renderBranchRows(width: number, height: number): readonly string[] {
    if (this.#branchLoading && this.#branches === undefined) return [this.#theme.fg("accent", "Loading branches…")];
    if (this.#branchError !== undefined && this.#branches === undefined) {
      return [this.#theme.fg("error", `Error: ${this.#branchError}`)];
    }
    const branches = this.#branches?.branches;
    if (branches === undefined || branches.length === 0) return [this.#theme.fg("muted", "No local branches found")];
    if (this.#branchSelectedIndex < this.#branchOffset) this.#branchOffset = this.#branchSelectedIndex;
    if (this.#branchSelectedIndex >= this.#branchOffset + height) this.#branchOffset = this.#branchSelectedIndex - height + 1;
    return branches
      .slice(this.#branchOffset, this.#branchOffset + height)
      .map((branch, offset) => this.#renderBranchRow(branch, this.#branchOffset + offset, width));
  }

  #renderBranchRow(branch: GitBranch, index: number, width: number): string {
    const selected = index === this.#branchSelectedIndex;
    const marker = branch.current ? "*" : " ";
    const switching = this.#branchSwitching === branch.name ? " (switching…)" : "";
    const raw = `${selected ? ">" : " "} ${marker} ${sanitizeTerminalText(branch.name).replaceAll("\n", " ")}${switching}`;
    if (selected && this.#focus === "tree") return renderSelectedRow(raw, width, this.#theme);
    return this.#theme.fg(branch.current ? "success" : "text", fitCell(raw, width));
  }

  #renderTreeRow(row: TreeRow, index: number, width: number): string {
    if (row.node.kind === "section") {
      const label = `── ${sanitizeTerminalText(row.node.name).replaceAll("\n", " ")} `;
      const fill = Math.max(0, width - label.length);
      return this.#theme.fg("muted", `${label}${"─".repeat(fill)}`);
    }
    const selected = index === this.#selectedIndex;
    const cursor = selected ? ">" : " ";
    const indent = "  ".repeat(row.depth);
    let raw: string;
    if (row.node.kind === "directory") {
      raw = `${cursor} ${indent}${row.expanded ? "▼" : "▶"} ${sanitizeTerminalText(row.node.name).replaceAll("\n", " ")}/`;
    } else {
      raw = `${cursor} ${indent}${row.node.status ?? " "}  ${sanitizeTerminalText(row.node.name).replaceAll("\n", " ")}`;
    }
    if (selected && this.#focus === "tree") return renderSelectedRow(raw, width, this.#theme);
    const color: ThemeColor = row.node.status === "U" || row.node.status === "D"
      ? "error"
      : row.node.status === "A"
        ? "success"
        : row.node.status === undefined
          ? "text"
          : "warning";
    return this.#theme.fg(color, fitCell(raw, width));
  }

  #renderPreviewRows(width: number, height: number): readonly string[] {
    const rows = this.#buildPreviewRows(width, height);
    this.#previewRows = rows;
    const selection = this.#selection;
    return selection === undefined ? rows : highlightSelection(rows, selection, width);
  }

  #buildPreviewRows(width: number, height: number): readonly string[] {
    this.#lastPreviewWidth = width;
    if (this.#leftMode === "log") {
      if (this.#commitDiffLoading && this.#commitDiff === undefined) return [this.#theme.fg("accent", "Loading commit preview…")];
      const commit = this.#commitDiff;
      if (commit === undefined) return [this.#theme.fg("muted", "Select a commit to preview")];
      if (commit.kind === "error") return [this.#theme.fg("error", `Error: ${errorMessage(commit.error ?? "Unable to load commit")}`)];
      const lines = this.#diffVisualRows(commit, width);
      const first = Math.max(0, Math.min(this.#previewScroll, Math.max(0, lines.length - height)));
      this.#previewScroll = first;
      return lines.slice(first, first + height);
    }
    if (this.#previewLoading && this.#preview === undefined) return [this.#theme.fg("accent", "Loading preview…")];
    const value = this.#preview;
    if (value === undefined) return [this.#theme.fg("muted", "Select a file to preview")];
    if (value.kind === "binary") {
      const lines = [this.#theme.fg("warning", "Binary file")];
      if (value.byteSize !== undefined) lines.push(this.#theme.fg("dim", `${value.byteSize.toLocaleString("en-US")} bytes`));
      return lines;
    }
    if (value.kind === "error") {
      return [this.#theme.fg("error", `Error: ${errorMessage(value.error ?? "Unable to load file")}`)];
    }

    if (value.kind === "diff") {
      const lines = this.#diffVisualRows(value, width);
      const start = Math.max(0, Math.min(this.#previewScroll, Math.max(0, lines.length - height)));
      this.#previewScroll = start;
      return lines.slice(start, start + height);
    }

    const start = Math.max(0, Math.min(this.#previewScroll, Math.max(0, value.lines.length - height)));
    this.#previewScroll = start;
    const gutter = String(Math.max(1, value.lines.length)).length;
    const colored = this.#highlightedWindow(value, start, start + height);
    return value.lines.slice(start, start + height).map((line, offset) => {
      const number = start + offset + 1;
      const highlighted = colored?.[offset];
      return highlighted === undefined
        ? renderNumberedLine(line, number, width, this.#theme, gutter)
        : renderHighlightedLine(highlighted, number, width, this.#theme, gutter);
    });
  }

  /**
   * Incrementally highlights sequentially revealed lines so multiline parser
   * state survives normal scrolling. A non-sequential jump highlights only its
   * visible window rather than synchronously parsing every skipped line.
   */
  #highlightedWindow(
    value: FilePreview,
    start: number,
    end: number,
  ): readonly string[] | undefined {
    if (this.#highlight === undefined || value.kind !== "text" || value.lines.length === 0) return undefined;
    let cached = this.#highlighted;
    if (cached?.preview !== value || cached.theme !== this.#highlightTheme) {
      let stream: HighlighterStream | undefined;
      try {
        stream = this.#highlight.createStream?.(value.path, this.#highlightTheme, this.#theme);
      } catch {
        stream = undefined;
      }
      cached = {
        preview: value,
        theme: this.#highlightTheme,
        stream,
        lines: [],
        windowStart: -1,
        windowEnd: -1,
        windowLines: undefined,
      };
      this.#highlighted = cached;
    }

    if (cached.stream !== undefined && start <= cached.lines.length) {
      if (end > cached.lines.length) {
        const source = value.lines
          .slice(cached.lines.length, end)
          .map(line => sanitizeTerminalText(line).replaceAll("\n", " "));
        try {
          const colored = cached.stream.push(`${source.join("\n")}\n`).split("\n");
          colored.pop();
          if (colored.length === source.length) cached.lines.push(...colored);
          else cached.stream = undefined;
        } catch {
          cached.stream = undefined;
        }
      }
      if (cached.stream !== undefined) return cached.lines.slice(start, end);
    }

    if (
      cached.windowStart === start
      && cached.windowEnd === end
    ) return cached.windowLines;
    const source = value.lines
      .slice(start, end)
      .map(line => sanitizeTerminalText(line).replaceAll("\n", " "));
    const colored = this.#highlight(
      source.join("\n"),
      value.path,
      this.#highlightTheme,
      this.#theme,
    );
    cached.windowStart = start;
    cached.windowEnd = end;
    cached.windowLines = colored !== undefined && colored.length === source.length
      ? colored
      : undefined;
    return cached.windowLines;
  }

  #footer(): string {
    const project = this.#snapshot;
    const pieces: string[] = [];
    if (this.#leftMode === "log" && this.#commitDiff?.truncated) pieces.push("commit preview truncated");
    else if (this.#leftMode === "log" && this.#history?.truncated) pieces.push("history truncated");
    else if (this.#preview?.truncated) pieces.push("preview truncated");
    else if (project?.truncated) pieces.push("listing truncated");
    if (this.#sessionName !== undefined && this.#sessionName.length > 0) pieces.push(sanitizeTerminalText(this.#sessionName).replaceAll("\n", " "));
    if (project?.kind === "filesystem") {
      pieces.push("filesystem", pluralFiles(project.allFiles.length));
    } else {
      const summary = project === undefined
        ? { files: 0, insertions: 0, deletions: 0 }
        : this.#scope === "workspace"
          ? project.workspaceSummary
          : project.sessionSummary;
      pieces.push(
        this.#usesChangeList() ? "changes" : this.#viewMode,
        this.#scope,
        `+${summary.insertions} -${summary.deletions}`,
        pluralFiles(summary.files),
      );
    }

    if (this.#refreshLoading) pieces.push("refreshing");
    else if (this.#refreshError !== undefined) pieces.push(`error: ${this.#refreshError}`);
    else if (this.#watchError !== undefined) pieces.push(`watch error: ${this.#watchError}`);
    else if (this.#leftMode === "log" && this.#historyLoading) pieces.push("loading history");
    else if (this.#leftMode === "log" && this.#commitDiffLoading) pieces.push("loading commit");
    else if (this.#previewLoading) pieces.push("loading preview");
    else if (this.#preview?.kind === "error") pieces.push("preview error");
    else if (project?.baselineEstablishedAt !== undefined) pieces.push(`baseline ${new Date(project.baselineEstablishedAt).toISOString()}`);
    if (this.#highlight !== undefined) {
      pieces.push(`theme ${getHighlightThemeLabel(this.#highlightTheme)}`, "t theme");
    }
    if (this.#leftMode === "log" ? this.#commitDiff?.kind === "diff" : this.#preview?.kind === "diff") {
      pieces.push(`${this.#diffLayout} diff`, `ctx ${diffContextLabel(this.#diffContext)}`);
      pieces.push(`mask ${Math.round(this.#diffMaskOpacity * 100)}%`, "-/= mask");
    }

    if (this.#leftMode === "branches") {
      if (this.#branchSwitching !== undefined) pieces.push(`switching to ${this.#branchSwitching}`);
      else if (this.#branchLoading) pieces.push("loading branches");
      else if (this.#branchError !== undefined) pieces.push(`error: ${this.#branchError}`);
    }

    if (this.#copyNotice !== undefined) pieces.push(this.#copyNotice);

    // `[` / `]` only move a divider that the side-by-side layout draws, so the
    // hint is omitted when the panel is showing a single pane.
    const width = this.#isWideLayout(this.#lastWidth) ? "[ ] width" : undefined;
    const hints = this.#leftMode === "branches"
      ? ["n/p select", "↵ switch", "b files", "? help"]
      : this.#leftMode === "log"
        ? this.#focus === "preview"
          ? ["F5/r refresh", "↑↓ scroll", "pgup/dn", "d/c diff", "g files", "←/h/tab/esc list", "drag copy", width]
          : ["F5/r reload", "n/p select", "→/l ↵ preview", "g files", "b branches", "tab", "\\ tree", width, "esc"]
        : this.#focus === "preview"
          ? ["F5/r refresh", "↑↓ scroll", "pgup/dn", "d/c diff", "\\ tree", "←/h/tab/esc tree", "drag copy", width]
          : project?.kind === "filesystem"
            ? ["F5/r refresh", "n/p move", "→/l preview", "↵ open", "tab", "\\ tree", width, "esc"]
            : ["F5/r refresh", "n/p move", "→/l preview", "↵ open", "tab", "\\ tree", "g log", "b branches", width, "v list", "m/a", "s", "esc"];
    pieces.push("i /btw history", hints.filter(hint => hint !== undefined).join(" · "));
    return pieces.join(" · ");
  }
}
