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
  type DiffLayout,
  type FilePreview,
  type ProjectSnapshot,
  type ReviewSource,
  type ViewMode,
} from "../contracts";
import {
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

  #viewMode: ViewMode = "modified";
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
  #previewScroll = 0;
  #refreshLoading = false;
  #refreshError: string | undefined;
  #refreshController: AbortController | undefined;
  #previewController: AbortController | undefined;
  #refreshGeneration = 0;
  #previewGeneration = 0;
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
    readonly preview: FilePreview;
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
    this.#beginRefresh();
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
      this.#beginRefresh();
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
    this.#refreshController?.abort();
    this.#previewController?.abort();
    this.#refreshController = undefined;
    this.#previewController = undefined;
    this.#highlighted = undefined;
    this.#diffRows = undefined;
    this.#cache = undefined;
  }

  #handleTreeInput(data: string): void {
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
    const path = this.#previewPath;
    if (path === undefined) {
      this.#requestRender();
      return;
    }
    this.#beginPreview(path, true);
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

  #beginRefresh(): void {
    if (this.#disposed || this.#doneCalled) return;
    const generation = ++this.#refreshGeneration;
    this.#refreshController?.abort();
    this.#previewController?.abort();
    this.#previewGeneration += 1;
    this.#previewController = undefined;
    this.#previewLoading = false;
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
        this.#rebuildRows(true);
        this.#requestRender();
      },
      error => {
        if (!this.#isCurrentRefresh(generation, controller) || isAbort(error, controller.signal)) return;
        this.#refreshController = undefined;
        this.#refreshLoading = false;
        this.#refreshError = errorMessage(error);
        this.#requestRender();
      },
    );
  }

  #isCurrentRefresh(generation: number, controller: AbortController): boolean {
    return !this.#disposed && generation === this.#refreshGeneration && this.#refreshController === controller;
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
    if (selected?.node.kind === "file") {
      this.#beginPreview(selected.node.path, forcePreview);
    } else {
      this.#cancelPreview();
    }
  }

  #selectedRow(): TreeRow | undefined {
    return this.#selectedIndex >= 0 ? this.#rows[this.#selectedIndex] : undefined;
  }

  #moveSelection(delta: number): void {
    if (this.#rows.length === 0) return;
    const next = Math.max(0, Math.min(this.#rows.length - 1, this.#selectedIndex + delta));
    if (next === this.#selectedIndex) return;
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
        this.#preview = {
          path,
          kind: "error",
          lines: [],
          truncated: false,
          error: errorMessage(error),
        };
        this.#requestRender();
      },
    );
  }

  #isCurrentPreview(generation: number, controller: AbortController, path: string): boolean {
    return !this.#disposed && generation === this.#previewGeneration && this.#previewController === controller && this.#previewPath === path;
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
    const value = this.#preview;
    if (value === undefined) return 1;
    if (value.kind === "binary") return value.byteSize === undefined ? 1 : 2;
    if (value.kind === "error") return 1;
    if (value.kind === "diff") {
      // Scrolling counts the rows the last render produced: pairing removals
      // with additions makes the split view shorter than the unified one.
      const rows = this.#splitDiffRows(value, this.#lastPreviewWidth);
      if (rows !== undefined) return rows.length;
    }
    return value.lines.length;
  }

  /**
   * Side-by-side rows for a diff preview, or `undefined` when the split layout
   * is off, the pane is too narrow, or the diff is not a plain two-way diff.
   */
  #splitDiffRows(value: FilePreview, width: number): readonly DiffRow[] | undefined {
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
    if (this.#snapshot?.kind === "filesystem") return "Project [filesystem]";
    return `Project [${this.#viewMode} · ${this.#scope}]`;
  }

  #previewTitle(): string {
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
    if (this.#snapshot === undefined) {
      const message = this.#refreshError === undefined ? "Loading project files…" : `Error: ${this.#refreshError}`;
      return [this.#theme.fg(this.#refreshError === undefined ? "accent" : "error", message)];
    }
    if (this.#rows.length === 0) {
      const message = this.#snapshot.kind === "filesystem"
        ? "No project files found"
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

  #renderTreeRow(row: TreeRow, index: number, width: number): string {
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
    if (this.#preview?.truncated) pieces.push("preview truncated");
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
      pieces.push(this.#viewMode, this.#scope, `+${summary.insertions} -${summary.deletions}`, pluralFiles(summary.files));
    }

    if (this.#refreshLoading) pieces.push("refreshing");
    else if (this.#refreshError !== undefined) pieces.push(`error: ${this.#refreshError}`);
    else if (this.#previewLoading) pieces.push("loading preview");
    else if (this.#preview?.kind === "error") pieces.push("preview error");
    else if (project?.baselineEstablishedAt !== undefined) pieces.push(`baseline ${new Date(project.baselineEstablishedAt).toISOString()}`);
    if (this.#highlight !== undefined) {
      pieces.push(`theme ${getHighlightThemeLabel(this.#highlightTheme)}`, "t theme");
    }
    if (this.#preview?.kind === "diff") {
      pieces.push(`${this.#diffLayout} diff`, `ctx ${diffContextLabel(this.#diffContext)}`);
    }

    if (this.#copyNotice !== undefined) pieces.push(this.#copyNotice);

    pieces.push(this.#focus === "preview"
      ? "F5/r refresh · ↑↓ scroll · pgup/dn · d/c diff · \\ tree · ←/h/tab/esc tree · drag copy · [ ] width"
      : project?.kind === "filesystem"
        ? "F5/r refresh · ↑↓ move · →/l preview · ↵ open · tab · \\ tree · [ ] width · esc"
        : "F5/r refresh · ↑↓ move · →/l preview · ↵ open · tab · \\ tree · [ ] width · m/a · s · esc");
    return pieces.join(" · ");
  }
}
