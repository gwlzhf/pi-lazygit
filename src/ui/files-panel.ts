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
  diffContextLabel,
  type CommitDiffPreview,
  type DiffLayout,
  type FilePreview,
  type GitBranch,
  type GitLogEntry,
  type ProjectSnapshot,
  type ReviewSource,
} from "../contracts";
import { type TreeRow } from "../model/tree";
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
import { PANEL_HELP_GROUPS, panelPresentation, type PanelPresentationInput } from "./presentation";
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
  renderDiffLine,
  renderDiffSplitRow,
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
import { ReviewController, type ReviewControllerState } from "./review-controller";

export interface FilesPanelOptions {
  readonly cwd: string;
  readonly source: ReviewSource;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly sessionName?: string;
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
  readonly highlight?: Highlighter;
  readonly done: (result: undefined) => void;
}

type RenderCache = {
  readonly width: number;
  readonly rows: number;
  readonly revision: number;
  readonly theme: Theme;
  readonly lines: readonly string[];
};

const WIDE_LAYOUT_MINIMUM = 80;
const WHEEL_STEP = 3;
const MOUSE_REPORT_PREFIX = "\x1b[<";

function errorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error)).replaceAll("\n", " ");
}

export class FilesPanel implements Component {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #sessionName: string | undefined;
  readonly #highlight: Highlighter | undefined;
  readonly #done: (result: undefined) => void;
  readonly #controller: ReviewController;
  #lastControllerState: ReviewControllerState | undefined;

  #treeOffset = 0;
  #logOffset = 0;
  #branchOffset = 0;
  #helpVisible = false;
  #lastWidth = 0;
  #lastTerminalRows = 0;
  #lastPreviewWidth = 0;
  #previewRows: readonly string[] = [];
  #selection: PreviewSelection | undefined;
  #selectionDrag = false;
  #dividerDrag = false;
  #copyNotice: string | undefined;
  #diffRows: { readonly preview: FilePreview | CommitDiffPreview; readonly rows: readonly DiffRow[] | undefined } | undefined;
  #highlighted: {
    readonly preview: FilePreview;
    readonly theme: HighlightThemeName;
    stream: HighlighterStream | undefined;
    readonly lines: string[];
    windowStart: number;
    windowEnd: number;
    windowLines: readonly string[] | undefined;
  } | undefined;
  #cache: RenderCache | undefined;
  #renderRevision = 0;
  #disposed = false;
  #doneCalled = false;

  constructor(options: FilesPanelOptions) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#keybindings = options.keybindings;
    this.#sessionName = options.sessionName;
    this.#highlight = options.highlight;
    this.#done = options.done;
    const controllerOptions = {
      cwd: options.cwd,
      source: options.source,
      ...(options.treeRatio === undefined ? {} : { treeRatio: options.treeRatio }),
      ...(options.onTreeRatioChange === undefined ? {} : { onTreeRatioChange: options.onTreeRatioChange }),
      ...(options.treeCollapsed === undefined ? {} : { treeCollapsed: options.treeCollapsed }),
      ...(options.onTreeCollapsedChange === undefined ? {} : { onTreeCollapsedChange: options.onTreeCollapsedChange }),
      ...(options.diffLayout === undefined ? {} : { diffLayout: options.diffLayout }),
      ...(options.onDiffLayoutChange === undefined ? {} : { onDiffLayoutChange: options.onDiffLayoutChange }),
      ...(options.diffContext === undefined ? {} : { diffContext: options.diffContext }),
      ...(options.onDiffContextChange === undefined ? {} : { onDiffContextChange: options.onDiffContextChange }),
      highlightTheme: options.highlightTheme ?? DEFAULT_HIGHLIGHT_THEME,
      ...(options.onHighlightThemeChange === undefined ? {} : { onHighlightThemeChange: options.onHighlightThemeChange }),
      onChange: () => {
        const next = this.#controller.state;
        const previous = this.#lastControllerState;
        this.#lastControllerState = next;
        if (previous !== undefined && this.#selectionNeedsRetirement(previous, next)) this.#retireSelection();
        this.#requestRender();
      },
    };
    this.#controller = new ReviewController(controllerOptions);
    this.#lastControllerState = this.#controller.state;
  }

  start(): void {
    this.#controller.start();
  }

  handleInput(data: string): void {
    if (this.#disposed || this.#doneCalled) return;
    if (data.startsWith(MOUSE_REPORT_PREFIX)) {
      routeSgrMouseInput(data, event => this.#routeMouse(event));
      return;
    }
    if (matchesKey(data, "?")) {
      this.#clearSelection();
      this.#helpVisible = !this.#helpVisible;
      this.#requestRender();
      return;
    }
    const interrupted = this.#keybindings.matches(data, "app.interrupt");
    if (interrupted || matchesKey(data, "escape")) {
      if (this.#helpVisible) {
        this.#helpVisible = false;
        this.#requestRender();
      } else if (this.#state.leftMode === "branches") {
        this.#clearSelection();
        this.#controller.toggleBranches();
      } else if (this.#state.focus === "preview") {
        this.#focusTree();
      } else {
        this.#finish();
      }
      return;
    }
    if (this.#helpVisible) return;
    if (matchesKey(data, "f5") || matchesKey(data, "r")) {
      this.#clearSelection();
      this.#controller.refresh();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      if (this.#state.treeCollapsed) {
        this.#controller.setTreeCollapsed(false);
      } else {
        this.#controller.toggleFocus();
      }
      return;
    }
    if (matchesKey(data, "b")) {
      this.#clearSelection();
      this.#controller.toggleBranches();
      return;
    }
    if (matchesKey(data, "\\") || matchesKey(data, "ctrl+b")) {
      this.#clearSelection();
      this.#controller.setTreeCollapsed(!this.#state.treeCollapsed);
      return;
    }
    if (matchesKey(data, "d")) {
      this.#clearSelection();
      this.#controller.toggleDiffLayout();
      return;
    }
    if (matchesKey(data, "c")) {
      this.#clearSelection();
      this.#controller.cycleDiffContext();
      return;
    }
    if (matchesKey(data, "[") || matchesKey(data, "ctrl+left")) {
      this.#controller.resizeTree(-1, this.#lastWidth);
      return;
    }
    if (matchesKey(data, "]") || matchesKey(data, "ctrl+right")) {
      this.#controller.resizeTree(1, this.#lastWidth);
      return;
    }
    if (this.#highlight !== undefined && matchesKey(data, "t")) {
      const index = HIGHLIGHT_THEMES.findIndex(theme => theme.name === this.#state.highlightTheme);
      const nextTheme = HIGHLIGHT_THEMES[(index + 1) % HIGHLIGHT_THEMES.length];
      if (nextTheme === undefined) return;
      this.#highlighted = undefined;
      this.#controller.setHighlightTheme?.(nextTheme.name);
      return;
    }
    if (this.#state.leftMode !== "branches" && matchesKey(data, "g")) {
      this.#clearSelection();
      this.#controller.toggleLeftMode();
      return;
    }
    if (this.#state.focus === "preview") this.#handlePreviewInput(data);
    else this.#handleTreeInput(data);
  }
  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const reportedRows = Math.floor(this.#tui.terminal.rows);
    const terminalRows = Number.isFinite(reportedRows) ? Math.max(0, reportedRows) : 0;
    if (this.#lastWidth !== safeWidth || this.#lastTerminalRows !== terminalRows) this.#retireSelection();
    this.#lastWidth = safeWidth;
    this.#lastTerminalRows = terminalRows;
    const state = this.#state;
    const cached = this.#cache;
    if (cached !== undefined && cached.width === safeWidth && cached.rows === terminalRows && cached.revision === state.revision + this.#renderRevision && cached.theme === this.#theme) {
      return cached.lines;
    }
    let lines: readonly string[];
    if (terminalRows === 0) {
      lines = Object.freeze([]);
    } else if (terminalRows === 1) {
      lines = Object.freeze([this.#overviewRow(safeWidth)]);
    } else if (terminalRows <= 3) {
      const wide = this.#isWideLayout(safeWidth);
      const leftWidth = this.#treeWidth(safeWidth);
      const paneRow = wide
        ? renderSplitBorder(this.#leftTitle(), this.#rightTitle(), safeWidth, leftWidth, "top", this.#theme)
        : renderSingleBorder(state.focus === "preview" ? this.#rightTitle() : this.#leftTitle(), safeWidth, "top", this.#theme);
      lines = Object.freeze(terminalRows === 2
        ? [this.#overviewRow(safeWidth), paneRow]
        : [this.#overviewRow(safeWidth), paneRow, renderSingleBorder(this.#footer(), safeWidth, "bottom", this.#theme)]);
    } else if (this.#helpVisible) {
      lines = this.#renderHelp(safeWidth, terminalRows);
    } else {
      const contentHeight = terminalRows - 3;
      lines = this.#isWideLayout(safeWidth)
        ? this.#renderWide(safeWidth, contentHeight)
        : this.#renderNarrow(safeWidth, contentHeight);
    }
    this.#cache = { width: safeWidth, rows: terminalRows, revision: state.revision + this.#renderRevision, theme: this.#theme, lines };
    return lines;
  }

  invalidate(): void {
    if (this.#disposed) return;
    this.#renderRevision += 1;
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
    this.#controller.dispose();
    this.#highlighted = undefined;
    this.#diffRows = undefined;
    this.#cache = undefined;
  }

  get #state() {
    return this.#controller.state;
  }

  #handleTreeInput(data: string): void {
    const state = this.#state;
    if (state.leftMode === "branches") {
      if (matchesKey(data, "up") || matchesKey(data, "p")) {
        this.#clearSelection();
        this.#controller.movePrimarySelection(-1);
      } else if (matchesKey(data, "down") || matchesKey(data, "n")) {
        this.#clearSelection();
        this.#controller.movePrimarySelection(1);
      } else if (matchesKey(data, "enter")) {
        this.#clearSelection();
        this.#controller.switchSelectedBranch();
      }
      return;
    }
    if (state.leftMode === "log") {
      if (matchesKey(data, "up") || matchesKey(data, "p")) {
        this.#clearSelection();
        this.#controller.movePrimarySelection(-1);
      } else if (matchesKey(data, "down") || matchesKey(data, "n")) {
        this.#clearSelection();
        this.#controller.movePrimarySelection(1);
      } else if (matchesKey(data, "enter") || matchesKey(data, "right") || matchesKey(data, "l")) {
        this.#clearSelection();
        this.#controller.focusPreview();
      }
      return;
    }
    if (matchesKey(data, "a")) {
      this.#clearSelection();
      this.#controller.setViewMode("all");
      return;
    }
    if (matchesKey(data, "m")) {
      this.#clearSelection();
      this.#controller.setViewMode("modified");
      return;
    }
    if (matchesKey(data, "s")) {
      this.#clearSelection();
      this.#controller.toggleScope();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "p")) {
      this.#clearSelection();
      this.#controller.movePrimarySelection(-1);
    } else if (matchesKey(data, "down") || matchesKey(data, "n")) {
      this.#clearSelection();
      this.#controller.movePrimarySelection(1);
    } else if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.#clearSelection();
      this.#controller.collapseOrParent();
    } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
      const selected = state.rows[state.selectedIndex];
      if (selected?.node.kind === "file") this.#controller.focusPreview();
      else {
        this.#clearSelection();
        this.#controller.expandOrChild();
      }
    } else if (matchesKey(data, "enter")) {
      this.#clearSelection();
      this.#controller.openSelection();
    }
  }

  #handlePreviewInput(data: string): void {
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.#focusTree();
      return;
    }
    const height = this.#previewViewportHeight();
    if (matchesKey(data, "home")) this.#scrollPreviewHome(height);
    else if (matchesKey(data, "end")) this.#scrollPreviewEnd(height);
    else if (matchesKey(data, "up") || matchesKey(data, "k")) this.#scrollPreview(-1, height);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.#scrollPreview(1, height);
    else if (matchesKey(data, "pageUp")) this.#scrollPreview(-height, height);
    else if (matchesKey(data, "pageDown")) this.#scrollPreview(height, height);
  }

  #focusTree(): void {
    this.#controller.focusTree();
  }

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
      const overTree = wide ? event.col <= treeWidth : this.#state.focus === "tree";
      if (overTree) {
        this.#clearSelection();
        this.#controller.movePrimarySelection(event.wheel * WHEEL_STEP);
      } else {
        this.#scrollPreview(event.wheel * WHEEL_STEP, this.#previewViewportHeight());
      }
      return true;
    }
    const point = this.#previewPoint(event, wide, treeWidth);
    if (event.leftClick) {
      this.#dividerDrag = wide && event.col === treeWidth + 1;
      this.#clearSelection();
      if (this.#dividerDrag) return true;
      const treeIndex = this.#treeRowIndex(event, wide, treeWidth);
      if (treeIndex !== undefined) {
        this.#controller.selectPrimary(treeIndex);
        return true;
      }
      if (point === undefined) return true;
      this.#controller.focusPreview();
      this.#selectionDrag = true;
      this.#selection = { anchor: point, head: point };
      this.#requestRender();
      return true;
    }
    if (event.motion && (event.button & 3) === 0) {
      if (this.#dividerDrag && wide) {
        this.#controller.setTreeColumns(event.col - 1, this.#lastWidth);
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

  #previewPoint(event: SgrMouseEvent, wide: boolean, treeWidth: number): SelectionPoint | undefined {
    const terminalRows = Math.floor(this.#tui.terminal.rows);
    if (!Number.isFinite(terminalRows) || terminalRows <= 3) return undefined;
    const row = event.row - 2;
    if (row < 0 || row >= terminalRows - 3) return undefined;
    const previewWidth = wide ? Math.max(0, this.#lastWidth - 3 - treeWidth) : Math.max(0, this.#lastWidth - 2);
    if (previewWidth === 0) return undefined;
    if (wide) {
      const col = event.col - treeWidth - 2;
      return col < 0 || col >= previewWidth ? undefined : { row, col };
    }
    if (this.#state.focus !== "preview") return undefined;
    const col = event.col - 1;
    return col < 0 || col >= previewWidth ? undefined : { row, col };
  }

  #treeRowIndex(event: SgrMouseEvent, wide: boolean, treeWidth: number): number | undefined {
    const terminalRows = Math.floor(this.#tui.terminal.rows);
    if (!Number.isFinite(terminalRows) || terminalRows <= 3) return undefined;
    const bodyHeight = terminalRows - 3;
    const row = event.row - 2;
    if (row < 0 || row >= bodyHeight) return undefined;
    if (wide) {
      if (event.col < 1 || event.col > treeWidth) return undefined;
    } else {
      if (this.#state.focus !== "tree") return undefined;
      const bodyWidth = Math.max(0, this.#lastWidth - 2);
      if (event.col < 1 || event.col > bodyWidth) return undefined;
    }
    const state = this.#state;
    const offset = state.leftMode === "branches" ? this.#branchOffset : state.leftMode === "log" ? this.#logOffset : this.#treeOffset;
    const length = state.leftMode === "branches"
      ? state.branches?.branches.length ?? 0
      : state.leftMode === "log" ? state.history?.entries.length ?? 0 : state.rows.length;
    const absolute = offset + row;
    return absolute >= 0 && absolute < length ? absolute : undefined;
  }

  #selectionNeedsRetirement(previous: ReviewControllerState, next: ReviewControllerState): boolean {
    return previous.rows !== next.rows
      || previous.selectedIndex !== next.selectedIndex
      || previous.preview !== next.preview
      || previous.previewPath !== next.previewPath
      || previous.treeRatio !== next.treeRatio
      || previous.treeCollapsed !== next.treeCollapsed
      || previous.diffLayout !== next.diffLayout
      || previous.diffContext !== next.diffContext
      || previous.leftMode !== next.leftMode
      || previous.viewMode !== next.viewMode
      || previous.scope !== next.scope
      || previous.history !== next.history
      || previous.logSelectedIndex !== next.logSelectedIndex
      || previous.commitDiff !== next.commitDiff
      || previous.branches !== next.branches
      || previous.branchSelectedIndex !== next.branchSelectedIndex;
  }

  #retireSelection(): void {
    this.#selectionDrag = false;
    this.#selection = undefined;
    this.#copyNotice = undefined;
  }

  #clearSelection(): void {
    if (this.#selection === undefined && this.#copyNotice === undefined) {
      this.#selectionDrag = false;
      return;
    }
    this.#retireSelection();
    this.#requestRender();
  }

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

  #isWideLayout(width: number): boolean {
    return !this.#state.treeCollapsed && width >= WIDE_LAYOUT_MINIMUM;
  }

  #treeWidth(width: number): number {
    const available = Math.max(0, Math.floor(width) - 3);
    const maximum = Math.floor(available * 0.3);
    const minimum = Math.min(maximum, 12);
    return Math.max(minimum, Math.min(maximum, Math.round(available * this.#state.treeRatio)));
  }

  #previewViewportHeight(): number {
    return Math.max(1, Math.max(4, Math.floor(this.#tui.terminal.rows)) - 3);
  }
  #scrollPreview(delta: number, height: number): void {
    const before = this.#state.previewScroll;
    this.#controller.scrollPreview(delta, height);
    if (this.#state.previewScroll !== before) this.#clearSelection();
  }

  #scrollPreviewHome(height: number): void {
    const before = this.#state.previewScroll;
    this.#controller.scrollPreviewHome(height);
    if (this.#state.previewScroll !== before) this.#clearSelection();
  }

  #scrollPreviewEnd(height: number): void {
    const before = this.#state.previewScroll;
    this.#controller.scrollPreviewEnd(height);
    if (this.#state.previewScroll !== before) this.#clearSelection();
  }

  #requestRender(): void {
    if (this.#disposed || this.#doneCalled) return;
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
      this.#overviewRow(width),
      renderSplitBorder(this.#leftTitle(), this.#rightTitle(), width, leftWidth, "top", this.#theme),
    ];
    for (let index = 0; index < height; index += 1) result.push(renderSplitRow(tree[index] ?? "", preview[index] ?? "", width, leftWidth, this.#theme));
    result.push(renderSingleBorder(this.#footer(), width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #renderNarrow(width: number, height: number): readonly string[] {
    const previewFocused = this.#state.focus === "preview";
    const bodyWidth = Math.max(0, width - 2);
    const body = previewFocused ? this.#renderPreviewRows(bodyWidth, height) : this.#renderTreeRows(bodyWidth, height);
    const result: string[] = [
      this.#overviewRow(width),
      renderSingleBorder(previewFocused ? this.#rightTitle() : this.#leftTitle(), width, "top", this.#theme),
    ];
    for (let index = 0; index < height; index += 1) result.push(renderSingleRow(body[index] ?? "", width, this.#theme));
    result.push(renderSingleBorder(this.#footer(), width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #renderHelp(width: number, terminalRows: number): readonly string[] {
    const height = Math.max(0, terminalRows - 3);
    const lines: string[] = [];
    for (const group of PANEL_HELP_GROUPS) {
      lines.push(this.#theme.fg("accent", group.title));
      for (const action of group.actions) lines.push(`  ${action.key}  ${action.label}`);
      lines.push("");
    }
    const body = lines.slice(0, Math.max(0, height));
    const result: string[] = [
      this.#overviewRow(width),
      renderSingleBorder("Help", width, "top", this.#theme),
    ];
    for (let index = 0; index < height; index += 1) result.push(renderSingleRow(body[index] ?? "", width, this.#theme));
    result.push(renderSingleBorder("esc close", width, "bottom", this.#theme));
    return Object.freeze(result);
  }

  #presentationInput(): PanelPresentationInput {
    const state = this.#state;
    const project = state.snapshot;
    const selected = state.leftMode === "files" ? state.rows[state.selectedIndex] : undefined;
    const selectedPath = state.leftMode === "files"
      ? (selected?.node.kind === "file" ? selected.node.path : state.previewPath)
      : undefined;
    const selectedSummary = selectedPath === undefined || project?.kind !== "git"
      ? undefined
      : project.workspaceSummaryByPath.get(selectedPath);
    const fileCount = project === undefined
      ? 0
      : project.kind === "git" ? project.workspaceSummary.files : project.allFiles.length;
    const status = this.#statusText();
    return {
      sourceKind: project?.kind,
      leftMode: state.leftMode,
      focus: state.focus,
      viewMode: state.viewMode,
      scope: state.scope,
      ...(project?.kind === "git" && project.currentBranch !== undefined ? { currentBranch: project.currentBranch } : {}),
      ...(project?.kind === "git" && project.detachedAt !== undefined ? { detachedAt: project.detachedAt } : {}),
      fileCount,
      ...(selectedPath === undefined ? {} : { selectedPath }),
      ...(selectedSummary === undefined ? {} : { selectedSummary }),
      ...(status === undefined ? {} : { status }),
    };
  }

  #statusText(): string | undefined {
    const state = this.#state;
    if (state.branchError !== undefined) return `switch error: ${state.branchError}`;
    if (state.refreshError !== undefined) return `error: ${state.refreshError}`;
    if (state.watchError !== undefined) return `watch error: ${state.watchError}`;
    if (state.leftMode === "log" && state.commitDiff?.kind === "error") return "commit error";
    if (state.preview?.kind === "error") return "preview error";
    if (state.branchSwitching !== undefined) return `switching to ${state.branchSwitching}`;
    if (state.branchLoading) return "loading branches";
    if (state.refreshLoading) return "refreshing";
    if (state.leftMode === "log" && state.historyLoading) return "loading history";
    if (state.leftMode === "log" && state.commitDiffLoading) return "loading commit";
    if (state.previewLoading) return "loading preview";
    if (this.#copyNotice !== undefined) return this.#copyNotice;
    return undefined;
  }

  #overviewRow(width: number): string {
    const presentation = panelPresentation(this.#presentationInput());
    const title = sanitizeTerminalText(presentation.overviewTitle).replaceAll("\n", " ");
    const meta = sanitizeTerminalText(presentation.overviewMeta).replaceAll("\n", " ");
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(meta));
    return this.#theme.fg("text", fitCell(`${title}${" ".repeat(gap)}${meta}`, width));
  }

  #leftTitle(): string {
    const state = this.#state;
    const base = panelPresentation(this.#presentationInput()).leftTitle;
    if (state.leftMode !== "files") return base;
    if (state.snapshot?.kind === "filesystem") return `${base} [filesystem]`;
    return `${base} [${state.viewMode} · ${state.scope}]`;
  }

  #rightTitle(): string {
    return panelPresentation(this.#presentationInput()).rightTitle;
  }

  #renderTreeRows(width: number, height: number): readonly string[] {
    const state = this.#state;
    if (state.leftMode === "branches") return this.#renderBranchRows(width, height);
    if (state.leftMode === "log") return this.#renderLogRows(width, height);
    if (state.snapshot === undefined) {
      const message = state.refreshError === undefined ? "Loading project files…" : `Error: ${state.refreshError}`;
      return [this.#theme.fg(state.refreshError === undefined ? "accent" : "error", message)];
    }
    if (state.rows.length === 0) {
      const message = state.snapshot.kind === "filesystem" ? "No project files found" : state.viewMode === "modified" ? `No ${state.scope} changes — press a for all files` : "No project files found";
      return [this.#theme.fg("muted", message)];
    }
    if (state.selectedIndex < this.#treeOffset) this.#treeOffset = state.selectedIndex;
    if (state.selectedIndex >= this.#treeOffset + height) this.#treeOffset = state.selectedIndex - height + 1;
    return state.rows.slice(this.#treeOffset, this.#treeOffset + height).map((row, offset) => this.#renderTreeRow(row, this.#treeOffset + offset, width));
  }

  #renderLogRows(width: number, height: number): readonly string[] {
    const state = this.#state;
    if (state.historyLoading && state.history === undefined) return [this.#theme.fg("accent", "Loading history…")];
    if (state.historyError !== undefined) return [this.#theme.fg("error", `Error: ${state.historyError}`)];
    const entries = state.history?.entries;
    if (entries === undefined || entries.length === 0) return [this.#theme.fg("muted", "No commits found")];
    if (state.logSelectedIndex < this.#logOffset) this.#logOffset = state.logSelectedIndex;
    if (state.logSelectedIndex >= this.#logOffset + height) this.#logOffset = state.logSelectedIndex - height + 1;
    return entries.slice(this.#logOffset, this.#logOffset + height).map((entry, offset) => this.#renderLogRow(entry, this.#logOffset + offset, width));
  }

  #renderLogRow(entry: GitLogEntry, index: number, width: number): string {
    const state = this.#state;
    const selected = index === state.logSelectedIndex;
    const raw = `${selected ? ">" : " "} ${sanitizeTerminalText(entry.shortOid).replaceAll("\n", " ")} ${sanitizeTerminalText(entry.subject).replaceAll("\n", " ")}`;
    if (selected && state.focus === "tree") return renderSelectedRow(raw, width, this.#theme);
    return this.#theme.fg("text", fitCell(raw, width));
  }

  #renderBranchRows(width: number, height: number): readonly string[] {
    const state = this.#state;
    if (state.branchLoading && state.branches === undefined) return [this.#theme.fg("accent", "Loading branches…")];
    if (state.branchError !== undefined && state.branches === undefined) return [this.#theme.fg("error", `Error: ${state.branchError}`)];
    const branches = state.branches?.branches;
    if (branches === undefined || branches.length === 0) return [this.#theme.fg("muted", "No local branches found")];
    if (state.branchSelectedIndex < this.#branchOffset) this.#branchOffset = state.branchSelectedIndex;
    if (state.branchSelectedIndex >= this.#branchOffset + height) this.#branchOffset = state.branchSelectedIndex - height + 1;
    return branches.slice(this.#branchOffset, this.#branchOffset + height).map((branch, offset) => this.#renderBranchRow(branch, this.#branchOffset + offset, width));
  }

  #renderBranchRow(branch: GitBranch, index: number, width: number): string {
    const state = this.#state;
    const selected = index === state.branchSelectedIndex;
    const cursor = selected ? ">" : " ";
    const marker = branch.current ? "*" : " ";
    const switching = state.branchSwitching === branch.name ? " (switching…)" : "";
    const raw = `${cursor} ${marker} ${sanitizeTerminalText(branch.name).replaceAll("\n", " ")}${switching}`;
    if (selected && state.focus === "tree") return renderSelectedRow(raw, width, this.#theme);
    return this.#theme.fg(branch.current ? "success" : "text", fitCell(raw, width));
  }

  #renderTreeRow(row: TreeRow, index: number, width: number): string {
    const state = this.#state;
    const selected = index === state.selectedIndex;
    const cursor = selected ? ">" : " ";
    const indent = "  ".repeat(row.depth);
    const raw = row.node.kind === "directory"
      ? `${cursor} ${indent}${row.expanded ? "▼" : "▶"} ${sanitizeTerminalText(row.node.name).replaceAll("\n", " ")}/`
      : `${cursor} ${indent}${row.node.status ?? " "}  ${sanitizeTerminalText(row.node.name).replaceAll("\n", " ")}`;
    if (selected && state.focus === "tree") return renderSelectedRow(raw, width, this.#theme);
    const color: ThemeColor = row.node.status === "U" || row.node.status === "D" ? "error" : row.node.status === "A" ? "success" : row.node.status === undefined ? "text" : "warning";
    return this.#theme.fg(color, fitCell(raw, width));
  }

  #renderPreviewRows(width: number, height: number): readonly string[] {
    const rows = this.#buildPreviewRows(width, height);
    this.#previewRows = rows;
    return this.#selection === undefined ? rows : highlightSelection(rows, this.#selection, width);
  }

  #buildPreviewRows(width: number, height: number): readonly string[] {
    this.#controller.setPreviewWidth(width);
    const state = this.#state;
    this.#lastPreviewWidth = width;
    if (state.leftMode === "log") {
      if (state.commitDiffLoading && state.commitDiff === undefined) return [this.#theme.fg("accent", "Loading commit preview…")];
      const commit = state.commitDiff;
      if (commit === undefined) return [this.#theme.fg("muted", "Select a commit to preview")];
      if (commit.kind === "error") return [this.#theme.fg("error", `Error: ${errorMessage(commit.error ?? "Unable to load commit")}`)];
      const rows = this.#splitDiffRows(commit, width);
      if (rows !== undefined) {
        const first = Math.max(0, Math.min(state.previewScroll, Math.max(0, rows.length - height)));
        const numbers = diffGutterWidth(rows);
        return rows.slice(first, first + height).map(row => renderDiffSplitRow(row, width, this.#theme, numbers));
      }
      const start = Math.max(0, Math.min(state.previewScroll, Math.max(0, commit.lines.length - height)));
      return commit.lines.slice(start, start + height).map(line => renderDiffLine(line, width, this.#theme));
    }
    if (state.previewLoading && state.preview === undefined) return [this.#theme.fg("accent", "Loading preview…")];
    const value = state.preview;
    if (value === undefined) return [this.#theme.fg("muted", "Select a file to preview")];
    if (value.kind === "binary") {
      const lines = [this.#theme.fg("warning", "Binary file")];
      if (value.byteSize !== undefined) lines.push(this.#theme.fg("dim", `${value.byteSize.toLocaleString("en-US")} bytes`));
      return lines;
    }
    if (value.kind === "error") return [this.#theme.fg("error", `Error: ${errorMessage(value.error ?? "Unable to load file")}`)];
    if (value.kind === "diff") {
      const rows = this.#splitDiffRows(value, width);
      if (rows !== undefined) {
        const first = Math.max(0, Math.min(state.previewScroll, Math.max(0, rows.length - height)));
        const numbers = diffGutterWidth(rows);
        return rows.slice(first, first + height).map(row => renderDiffSplitRow(row, width, this.#theme, numbers));
      }
      const start = Math.max(0, Math.min(state.previewScroll, Math.max(0, value.lines.length - height)));
      return value.lines.slice(start, start + height).map(line => renderDiffLine(line, width, this.#theme));
    }
    const start = Math.max(0, Math.min(state.previewScroll, Math.max(0, value.lines.length - height)));
    const gutter = String(Math.max(1, value.lines.length)).length;
    const colored = this.#highlightedWindow(value, start, start + height);
    return value.lines.slice(start, start + height).map((line, offset) => {
      const number = start + offset + 1;
      const highlighted = colored?.[offset];
      return highlighted === undefined ? renderNumberedLine(line, number, width, this.#theme, gutter) : renderHighlightedLine(highlighted, number, width, this.#theme, gutter);
    });
  }

  #splitDiffRows(value: FilePreview | CommitDiffPreview, width: number): readonly DiffRow[] | undefined {
    if (this.#state.diffLayout !== "split" || value.kind !== "diff" || width < SPLIT_DIFF_MINIMUM_WIDTH) return undefined;
    let cached = this.#diffRows;
    if (cached?.preview !== value) {
      const rows = parseUnifiedDiff(value.lines);
      if (rows === undefined) return undefined;
      cached = { preview: value, rows };
      this.#diffRows = cached;
    }
    return cached.rows;
  }

  #highlightedWindow(value: FilePreview, start: number, end: number): readonly string[] | undefined {
    if (this.#highlight === undefined || value.kind !== "text" || value.lines.length === 0) return undefined;
    let cached = this.#highlighted;
    const state = this.#state;
    if (cached?.preview !== value || cached.theme !== state.highlightTheme) {
      let stream: HighlighterStream | undefined;
      try { stream = this.#highlight.createStream?.(value.path, state.highlightTheme, this.#theme); } catch { stream = undefined; }
      cached = { preview: value, theme: state.highlightTheme, stream, lines: [], windowStart: -1, windowEnd: -1, windowLines: undefined };
      this.#highlighted = cached;
    }
    if (cached.stream !== undefined && start <= cached.lines.length) {
      if (end > cached.lines.length) {
        const source = value.lines.slice(cached.lines.length, end).map(line => sanitizeTerminalText(line).replaceAll("\n", " "));
        try {
          const colored = cached.stream.push(`${source.join("\n")}\n`).split("\n");
          colored.pop();
          if (colored.length === source.length) cached.lines.push(...colored); else cached.stream = undefined;
        } catch { cached.stream = undefined; }
      }
      if (cached.stream !== undefined) return cached.lines.slice(start, end);
    }
    if (cached.windowStart === start && cached.windowEnd === end) return cached.windowLines;
    const source = value.lines.slice(start, end).map(line => sanitizeTerminalText(line).replaceAll("\n", " "));
    const colored = this.#highlight(source.join("\n"), value.path, state.highlightTheme, this.#theme);
    cached.windowStart = start;
    cached.windowEnd = end;
    cached.windowLines = colored !== undefined && colored.length === source.length ? colored : undefined;
    return cached.windowLines;
  }

  #footer(): string {
    const state = this.#state;
    const project = state.snapshot;
    const presentation = panelPresentation(this.#presentationInput());
    const pieces: string[] = [];
    if (state.leftMode === "log" && state.commitDiff?.truncated) pieces.push("commit preview truncated");
    else if (state.leftMode === "log" && state.history?.truncated) pieces.push("history truncated");
    else if (state.preview?.truncated) pieces.push("preview truncated");
    else if (project?.truncated) pieces.push("listing truncated");
    if (this.#sessionName !== undefined && this.#sessionName.length > 0) pieces.push(sanitizeTerminalText(this.#sessionName).replaceAll("\n", " "));
    if (state.leftMode === "files") {
      if (project?.kind === "filesystem") pieces.push("filesystem", `${project.allFiles.length} ${project.allFiles.length === 1 ? "file" : "files"}`);
      else {
        const summary = project === undefined ? { files: 0, insertions: 0, deletions: 0 } : state.scope === "workspace" ? project.workspaceSummary : project.sessionSummary;
        pieces.push(state.viewMode, state.scope, `+${summary.insertions} -${summary.deletions}`, `${summary.files} ${summary.files === 1 ? "file" : "files"}`);
      }
    }
    if (presentation.status !== undefined) pieces.push(presentation.status);
    else if (project?.baselineEstablishedAt !== undefined && state.leftMode === "files") pieces.push(`baseline ${new Date(project.baselineEstablishedAt).toISOString()}`);
    if (this.#highlight !== undefined) pieces.push(`theme ${getHighlightThemeLabel(state.highlightTheme)}`, "t theme");
    if (state.leftMode === "log" ? state.commitDiff?.kind === "diff" : state.preview?.kind === "diff") pieces.push(`${state.diffLayout} diff`, `ctx ${diffContextLabel(state.diffContext)}`);
    const width = this.#isWideLayout(this.#lastWidth) ? "[ ] width" : undefined;
    const hints = [
      "F5/r refresh",
      ...presentation.actions.map(action => `${action.key} ${action.label}`),
      width,
    ];
    pieces.push(hints.filter(hint => hint !== undefined).join(" · "));
    return pieces.join(" · ");
  }

  #selectedLogEntry(): GitLogEntry | undefined {
    const state = this.#state;
    return state.logSelectedIndex < 0 ? undefined : state.history?.entries[state.logSelectedIndex];
  }
}
