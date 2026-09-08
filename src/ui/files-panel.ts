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
  DEFAULT_TREE_RATIO,
  TREE_MAX_RATIO,
  TREE_MIN_COLUMNS,
  TREE_MIN_RATIO,
  type ChangeRecord,
  type ChangeScope,
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
import type { Highlighter } from "./highlight";
import {
  renderDiffLine,
  renderHighlightedLine,
  renderNumberedLine,
  renderSingleBorder,
  renderSingleRow,
  renderSplitBorder,
  renderSplitRow,
  sanitizeTerminalText,
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
  #lastWidth = 0;
  #dividerDrag = false;
  #highlighted: { readonly preview: FilePreview; readonly lines: readonly string[] | undefined } | undefined;
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
    this.#highlight = options.highlight;
    this.#treeRatio = Math.max(TREE_MIN_RATIO, Math.min(TREE_MAX_RATIO, options.treeRatio ?? DEFAULT_TREE_RATIO));
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
        this.#focus = "tree";
        this.#requestRender();
      } else {
        this.#finish();
      }
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.#focus = this.#focus === "tree" ? "preview" : "tree";
      this.#requestRender();
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
      const wide = safeWidth >= WIDE_LAYOUT_MINIMUM;
      const leftWidth = this.#treeWidth(safeWidth);
      const header = wide
        ? renderSplitBorder(this.#treeTitle(), this.#previewTitle(), safeWidth, leftWidth, "top", this.#theme)
        : renderSingleBorder(this.#focus === "preview" ? this.#previewTitle() : this.#treeTitle(), safeWidth, "top", this.#theme);
      lines = Object.freeze(terminalRows === 1
        ? [header]
        : [header, renderSingleBorder(this.#footer(), safeWidth, "bottom", this.#theme)]);
    } else {
      const contentHeight = terminalRows - 2;
      lines = safeWidth >= WIDE_LAYOUT_MINIMUM
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
    this.#refreshGeneration += 1;
    this.#previewGeneration += 1;
    this.#refreshController?.abort();
    this.#previewController?.abort();
    this.#refreshController = undefined;
    this.#previewController = undefined;
    this.#highlighted = undefined;
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
    if (matchesKey(data, "r")) {
      this.#beginRefresh();
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
      this.#expandOrChild();
      return;
    }
    if (matchesKey(data, "enter")) this.#openSelection();
  }

  #handlePreviewInput(data: string): void {
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.#focus = "tree";
      this.#requestRender();
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
    const wide = this.#lastWidth >= WIDE_LAYOUT_MINIMUM;
    const treeWidth = this.#treeWidth(this.#lastWidth);
    if (event.release) {
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
      return true;
    }
    // Motion with the left button held (low button bits clear) is a drag.
    if (event.motion && this.#dividerDrag && wide && (event.button & 3) === 0) {
      this.#setTreeColumns(event.col - 1);
    }
    return true;
  }

  /** Tree pane columns for a panel width, clamped to the resize bounds. */
  #treeWidth(width: number): number {
    const available = Math.max(0, Math.floor(width) - 3);
    const maximum = Math.floor(available * TREE_MAX_RATIO);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    return Math.max(minimum, Math.min(maximum, Math.round(available * this.#treeRatio)));
  }

  #resizeTree(deltaColumns: number): void {
    this.#setTreeColumns(this.#treeWidth(this.#lastWidth) + deltaColumns);
  }

  #setTreeColumns(columns: number): void {
    const available = Math.max(0, this.#lastWidth - 3);
    if (available === 0) return;
    const maximum = Math.floor(available * TREE_MAX_RATIO);
    const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(columns)));
    if (clamped === this.#treeWidth(this.#lastWidth)) return;
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

    void this.#source.preview(path, { signal: controller.signal }).then(
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
    this.#previewGeneration += 1;
    this.#previewController?.abort();
    this.#previewController = undefined;
    this.#previewPath = undefined;
    this.#preview = undefined;
    this.#previewLoading = false;
    this.#previewScroll = 0;
    this.#highlighted = undefined;
  }

  #setPreviewScroll(next: number, height: number): void {
    const maximum = Math.max(0, this.#previewLineCount() - height);
    const clamped = Math.max(0, Math.min(maximum, next));
    if (clamped === this.#previewScroll) return;
    this.#previewScroll = clamped;
    this.#requestRender();
  }

  #previewLineCount(): number {
    const value = this.#preview;
    if (value === undefined) return 1;
    if (value.kind === "binary") return value.byteSize === undefined ? 1 : 2;
    if (value.kind === "error") return 1;
    return value.lines.length;
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

    const start = Math.max(0, Math.min(this.#previewScroll, Math.max(0, value.lines.length - height)));
    this.#previewScroll = start;
    const gutter = String(Math.max(1, value.lines.length)).length;
    if (value.kind === "diff") {
      return value.lines.slice(start, start + height).map(line => renderDiffLine(line, width, this.#theme));
    }
    const colored = this.#highlightedLines(value);
    return value.lines.slice(start, start + height).map((line, offset) => {
      const number = start + offset + 1;
      const highlighted = colored?.[start + offset];
      return highlighted === undefined
        ? renderNumberedLine(line, number, width, this.#theme, gutter)
        : renderHighlightedLine(highlighted, number, width, this.#theme, gutter);
    });
  }

  /**
   * Syntax-highlighted copy of a text preview, computed once per preview.
   * Content is sanitized before it is colored, so the highlighter only ever
   * adds escape sequences to inert text. Returns undefined when no highlighter
   * is installed, the language is unknown, or the result does not line up with
   * the source.
   */
  #highlightedLines(value: FilePreview): readonly string[] | undefined {
    if (this.#highlight === undefined || value.kind !== "text" || value.lines.length === 0) return undefined;
    if (this.#highlighted?.preview === value) return this.#highlighted.lines;
    const source = value.lines.map(line => sanitizeTerminalText(line).replaceAll("\n", " "));
    const colored = this.#highlight(source.join("\n"), value.path, this.#theme);
    const lines = colored !== undefined && colored.length === source.length ? colored : undefined;
    this.#highlighted = { preview: value, lines };
    return lines;
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

    pieces.push(this.#focus === "preview"
      ? "↑↓ scroll · pgup/dn · tab/h/esc tree · [ ] width"
      : project?.kind === "filesystem"
        ? "↑↓ move · ↵ open · tab · [ ] width · r · esc"
        : "↑↓ move · ↵ open · tab · [ ] width · m/a · s · r · esc");
    return pieces.join(" · ");
  }
}
