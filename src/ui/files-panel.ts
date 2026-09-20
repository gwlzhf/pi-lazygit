import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import {
  matchesKey,
  routeSgrMouseInput,
  type Component,
  type KeybindingsManager,
  type SgrMouseEvent,
  type TUI,
} from "@oh-my-pi/pi-tui";
import {
  DEFAULT_DIFF_CONTEXT,
  DEFAULT_DIFF_LAYOUT,
  DEFAULT_TREE_RATIO,
  diffContextLabel,
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
  renderDiffLine,
  renderDiffSplitRow,
  renderHighlightedLine,
  renderNumberedLine,
  renderSingleBorder,
  renderSingleRow,
  renderSplitBorder,
  renderSplitRow,
  sanitizeTerminalText,
  SPLIT_DIFF_MINIMUM_WIDTH,
} from "./render";

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
  /** Syntax palette restored from persisted settings. */
  readonly highlightTheme?: HighlightThemeName;
  /** Reports every syntax palette change so the host can persist it. */
  readonly onHighlightThemeChange?: (theme: HighlightThemeName) => void;
  /** Colors text previews; previews render unstyled when omitted. */
  readonly highlight?: Highlighter;
  readonly done: (result: undefined) => void;
}

type PanelFocus = "tree" | "preview";

type LeftMode = "files" | "log";

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
  readonly #highlight: Highlighter | undefined;
  readonly #done: (result: undefined) => void;

  #leftMode: LeftMode = "files";
  #viewMode: ViewMode = "modified";
  #listLayout: ListLayout = "tree";
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
    this.#highlight = options.highlight;
    this.#treeRatio = Math.max(TREE_MIN_RATIO, Math.min(TREE_MAX_RATIO, options.treeRatio ?? DEFAULT_TREE_RATIO));
    this.#treeCollapsed = options.treeCollapsed ?? false;
    this.#focus = this.#treeCollapsed ? "preview" : "tree";
    this.#diffLayout = isDiffLayout(options.diffLayout) ? options.diffLayout : DEFAULT_DIFF_LAYOUT;
    this.#diffContext = normalizeDiffContext(options.diffContext) ?? DEFAULT_DIFF_CONTEXT;
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
      if (this.#focus === "preview") {
        this.#focusTree();
      } else {
        this.#finish();
      }
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
    if (terminalRows === 0) {
      lines = Object.freeze([]);
    } else if (terminalRows <= 2) {
      const wide = this.#isWideLayout(safeWidth);
      const leftWidth = this.#treeWidth(safeWidth);
      const header = wide
        ? renderSplitBorder(this.#treeTitle(), this.#previewTitle(), safeWidth, leftWidth, "top", this.#theme)
        : renderSingleBorder(this.#focus === "preview" ? this.#previewTitle() : this.#treeTitle(), safeWidth, "top", this.#theme);
      lines = Object.freeze(terminalRows === 1
        ? [header]
        : [header, renderSingleBorder(this.#footer(), safeWidth, "bottom", this.#theme)]);
    } else {
      const contentHeight = terminalRows - 2;
      lines = this.#isWideLayout(safeWidth)
        ? this.#renderWide(safeWidth, contentHeight)
        : this.#renderNarrow(safeWidth, contentHeight);
    }
    this.#cache = {
      width: safeWidth,
      rows: terminalRows,
      revision: this.#revision,
      theme: this.#theme,
      lines,
    };
    return lines;
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
    this.#refreshController = undefined;
    this.#previewController = undefined;
    this.#historyController = undefined;
    this.#commitDiffController = undefined;
    this.#watchController = undefined;
    this.#highlighted = undefined;
    this.#diffRows = undefined;
    this.#cache = undefined;
  }

  #handleTreeInput(data: string): void {
    if (this.#leftMode === "log") {
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        this.#moveLogSelection(-1);
        return;
      }
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
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
      if (this.#snapshot?.kind === "git" && this.#viewMode !== "all") {
        this.#viewMode = "all";
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
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.#moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
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
    const point = this.#previewPoint(event, wide, treeWidth);
    if (event.leftClick) {
      this.#dividerDrag = wide && event.col === treeWidth + 1;
      this.#clearSelection();
      if (this.#dividerDrag || point === undefined) return true;
      // A press inside the preview both takes focus and anchors a text drag.
      this.#focusPreview();
      this.#selectionDrag = true;
      this.#selection = { anchor: point, head: point };
      this.#requestRender();
      return true;
    }
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
    const terminalRows = Math.floor(this.#tui.terminal.rows);
    if (!Number.isFinite(terminalRows) || terminalRows <= 2) return undefined;
    // Row 0 is the top border and the last row is the footer border.
    const row = event.row - 1;
    if (row < 0 || row >= terminalRows - 2) return undefined;
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

  /** Tree pane columns for a panel width, clamped to the resize bounds. */
  #treeWidth(width: number): number {
    const available = Math.max(0, Math.floor(width) - 3);
    const maximum = Math.floor(available * TREE_MAX_RATIO);
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
    const maximum = Math.floor(available * TREE_MAX_RATIO);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(columns)));
    if (clamped === this.#treeWidth(this.#lastWidth)) return;
    this.#clearSelection();
    this.#treeRatio = clamped / available;
    this.#onTreeRatioChange?.(this.#treeRatio);
    this.#requestRender();
  }

  #previewViewportHeight(): number {
    return Math.max(1, Math.max(3, Math.floor(this.#tui.terminal.rows)) - 2);
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
    if (this.#leftMode === "log") {
      const commit = this.#commitDiff;
      if (commit === undefined) return 1;
      const rows = this.#splitDiffRows(commit, this.#lastPreviewWidth);
      return rows === undefined ? commit.lines.length : rows.length;
    }
    const value = this.#preview;
    if (value === undefined) return 1;
    if (value.kind === "binary") return value.byteSize === undefined ? 1 : 2;
    if (value.kind === "error") return 1;
    const rows = this.#splitDiffRows(value, this.#lastPreviewWidth);
    return rows === undefined ? value.lines.length : rows.length;
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
      renderSingleBorder(previewFocused ? this.#previewTitle() : this.#treeTitle(), width, "top", this.#theme),
    ];
    for (let index = 0; index < height; index += 1) {
      result.push(renderSingleRow(body[index] ?? "", width, this.#theme));
    }
    result.push(renderSingleBorder(this.#footer(), width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #treeTitle(): string {
    if (this.#leftMode === "log") return "History";
    if (this.#snapshot?.kind === "filesystem") return "Project [filesystem]";
    const listing = this.#usesChangeList() ? "changes" : this.#viewMode;
    return `Project [${listing} · ${this.#scope}]`;
  }

  #previewTitle(): string {
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

  #renderLogRows(_width: number, height: number): readonly string[] {
    if (this.#historyLoading && this.#history === undefined) return [this.#theme.fg("accent", "Loading history…")];
    if (this.#historyError !== undefined) return [this.#theme.fg("error", `Error: ${this.#historyError}`)];
    const entries = this.#history?.entries;
    if (entries === undefined || entries.length === 0) return [this.#theme.fg("muted", "No commits found")];
    if (this.#logSelectedIndex < this.#logOffset) this.#logOffset = this.#logSelectedIndex;
    if (this.#logSelectedIndex >= this.#logOffset + height) this.#logOffset = this.#logSelectedIndex - height + 1;
    return entries
      .slice(this.#logOffset, this.#logOffset + height)
      .map((entry, offset) => this.#renderLogRow(entry, this.#logOffset + offset));
  }

  #renderLogRow(entry: GitLogEntry, index: number): string {
    const selected = index === this.#logSelectedIndex;
    const raw = `${selected ? ">" : " "} ${sanitizeTerminalText(entry.shortOid).replaceAll("\n", " ")} ${sanitizeTerminalText(entry.subject).replaceAll("\n", " ")}`;
    return this.#theme.fg(selected && this.#focus === "tree" ? "accent" : "text", raw);
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
    const color: ThemeColor = selected && this.#focus === "tree"
      ? "accent"
      : row.node.status === "U" || row.node.status === "D"
        ? "error"
        : row.node.status === "A"
          ? "success"
          : row.node.status === undefined
            ? "text"
            : "warning";
    return this.#theme.fg(color, raw);
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
      const rows = this.#splitDiffRows(commit, width);
      if (rows !== undefined) {
        const first = Math.max(0, Math.min(this.#previewScroll, Math.max(0, rows.length - height)));
        this.#previewScroll = first;
        const numbers = diffGutterWidth(rows);
        return rows
          .slice(first, first + height)
          .map(row => renderDiffSplitRow(row, width, this.#theme, numbers));
      }
      const start = Math.max(0, Math.min(this.#previewScroll, Math.max(0, commit.lines.length - height)));
      this.#previewScroll = start;
      return commit.lines.slice(start, start + height).map(line => renderDiffLine(line, width, this.#theme));
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
      const rows = this.#splitDiffRows(value, width);
      if (rows !== undefined) {
        const first = Math.max(0, Math.min(this.#previewScroll, Math.max(0, rows.length - height)));
        this.#previewScroll = first;
        const numbers = diffGutterWidth(rows);
        return rows
          .slice(first, first + height)
          .map(row => renderDiffSplitRow(row, width, this.#theme, numbers));
      }
    }

    const start = Math.max(0, Math.min(this.#previewScroll, Math.max(0, value.lines.length - height)));
    this.#previewScroll = start;
    const gutter = String(Math.max(1, value.lines.length)).length;
    if (value.kind === "diff") {
      return value.lines.slice(start, start + height).map(line => renderDiffLine(line, width, this.#theme));
    }
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
    }

    if (this.#copyNotice !== undefined) pieces.push(this.#copyNotice);

    // `[` / `]` only move a divider that the side-by-side layout draws, so the
    // hint is omitted when the panel is showing a single pane.
    const width = this.#isWideLayout(this.#lastWidth) ? "[ ] width" : undefined;
    const hints = this.#leftMode === "log"
      ? this.#focus === "preview"
        ? ["F5/r refresh", "↑↓ scroll", "pgup/dn", "d/c diff", "g files", "←/h/tab/esc list", "drag copy", width]
        : ["F5/r reload", "↑↓ select", "→/l ↵ preview", "g files", "tab", "\\ tree", width, "esc"]
      : this.#focus === "preview"
        ? ["F5/r refresh", "↑↓ scroll", "pgup/dn", "d/c diff", "\\ tree", "←/h/tab/esc tree", "drag copy", width]
        : project?.kind === "filesystem"
          ? ["F5/r refresh", "↑↓ move", "→/l preview", "↵ open", "tab", "\\ tree", width, "esc"]
          : ["F5/r refresh", "↑↓ move", "→/l preview", "↵ open", "tab", "\\ tree", "g log", width, "v list", "m/a", "s", "esc"];
    pieces.push(hints.filter(hint => hint !== undefined).join(" · "));
    return pieces.join(" · ");
  }
}
