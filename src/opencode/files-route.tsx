/** @jsxImportSource @opentui/solid */

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type MouseEvent } from "@opentui/core";
import { useTerminalDimensions, type JSX } from "@opentui/solid";
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { useBindings } from "@opentui/keymap/solid";
import {
  DIFF_CONTEXT_LEVELS,
  TREE_MAX_RATIO,
  TREE_MIN_COLUMNS,
  TREE_MIN_RATIO,
  diffContextLabel,
  type ChangeSummary,
  type CommitDiffPreview,
  type FilePreview,
  type GitBranch,
  type GitLogEntry,
  type ProjectSnapshot,
  type ReviewSource,
  type ViewMode,
} from "../contracts";
import { type TreeRow } from "../model/tree";
import {
  DEFAULT_PANEL_SETTINGS,
  type PanelSettingsStore,
} from "../settings";
import { diffGutterWidth, parseUnifiedDiff, type DiffRow } from "../ui/diff-view";
import { panelPresentation, PANEL_HELP_GROUPS, type PanelPresentationInput } from "../ui/presentation";
import {
  ReviewController,
  type LeftMode,
  type PanelFocus,
  type ReviewControllerState,
} from "../ui/review-controller";
import {
  isEmptySelection,
  orderSelection,
  sanitizeCopiedText,
  selectedSpans,
  selectionText,
  sliceByColumns,
  visibleWidth,
  type PreviewSelection,
  type SelectionPoint,
  type SelectionSpan,
} from "./selection";

const WIDE_LAYOUT_MINIMUM = 80;
const WHEEL_STEP = 3;
const BODY_TOP = 2;
const FOOTER_ROWS = 1;
const SPLIT_DIFF_MINIMUM_WIDTH = 40;
const SPLIT_DIFF_SEPARATOR = "│";
const SPLIT_DIFF_SEPARATOR_WIDTH = 1;
export interface FilesRouteDimensions {
  readonly width: number;
  readonly height: number;
}

export function routeDimensionsChanged(previous: FilesRouteDimensions | undefined, next: FilesRouteDimensions): boolean {
  return previous !== undefined && (previous.width !== next.width || previous.height !== next.height);
}

export interface FilesRouteProps {
  readonly api: TuiPluginApi;
  readonly cwd: string;
  readonly settings: PanelSettingsStore;
  readonly createSource: (cwd: string) => ReviewSource;
  readonly onClose: () => void;
}

type ThemeTokens = TuiThemeCurrent;

function safeText(value: string): string {
  return sanitizeCopiedText(value).replaceAll("\n", " ");
}

function summaryFor(snapshot: ProjectSnapshot | undefined, scope: ReviewControllerState["scope"]): ChangeSummary {
  if (snapshot === undefined) return { files: 0, insertions: 0, deletions: 0 };
  return snapshot.kind === "filesystem"
    ? { files: snapshot.allFiles.length, insertions: 0, deletions: 0 }
    : scope === "workspace" ? snapshot.workspaceSummary : snapshot.sessionSummary;
}

function isWide(width: number, state: ReviewControllerState | undefined): boolean {
  return state !== undefined && !state.treeCollapsed && width >= WIDE_LAYOUT_MINIMUM;
}

function treeWidth(width: number, ratio: number): number {
  const available = Math.max(0, Math.floor(width) - 3);
  const maximum = Math.floor(available * TREE_MAX_RATIO);
  const minimum = Math.min(maximum, TREE_MIN_COLUMNS);
  return Math.max(minimum, Math.min(maximum, Math.round(available * Math.max(TREE_MIN_RATIO, Math.min(TREE_MAX_RATIO, ratio)))));
}

// The pane border stays a static, generic "Preview" label (mirroring the static "Files" /
// "History" / "Switch branch" left-pane labels). The selected path and its +N -N summary live
// in the overview row instead, so this title never echoes row text that a viewport row-scan
// (mouse mapping, selected-row lookup) could otherwise collide with.
function previewTitle(state: ReviewControllerState | undefined): string {
  if (state === undefined) return "Preview";
  if (state.leftMode === "log") {
    const entry = state.logSelectedIndex >= 0 ? state.history?.entries[state.logSelectedIndex] : undefined;
    if (entry === undefined) return "Preview";
    if (state.commitDiffLoading) return "Preview (loading)";
    return state.commitDiff?.kind === "error" ? "Preview (error)" : "Preview";
  }
  const selected = state.rows[state.selectedIndex];
  const path = state.previewPath ?? (selected?.node.kind === "file" ? selected.node.path : undefined);
  if (path === undefined) return "Preview";
  if (state.previewLoading) return "Preview (loading)";
  switch (state.preview?.kind) {
    case "diff": return "Preview (diff)";
    case "binary": return "Preview (binary)";
    case "error": return "Preview (error)";
    default: return "Preview";
  }
}

function treeTitle(state: ReviewControllerState | undefined): string {
  if (state?.leftMode === "branches") return "Switch branch";
  if (state?.leftMode === "log") return "History";
  if (state?.snapshot?.kind === "filesystem") return "Project [filesystem]";
  return `Project [${state?.viewMode ?? "modified"} · ${state?.scope ?? "workspace"}]`;
}

function statusColor(status: string | undefined, theme: ThemeTokens): ThemeTokens["text"] {
  if (status === "A") return theme.success;
  if (status === "D" || status === "U") return theme.error;
  if (status === undefined) return theme.text;
  return theme.warning;
}

export function diffColor(kind: string, theme: ThemeTokens): ThemeTokens["text"] {
  if (kind === "text") return theme.text;
  if (kind === "add") return theme.diffAdded;
  if (kind === "remove") return theme.diffRemoved;
  if (kind === "hunk") return theme.diffHunkHeader;
  return theme.diffContext;
}

/** Full-row background mask for diff line kinds; ordinary text keeps a transparent background. */
function diffBg(kind: string, theme: ThemeTokens): ThemeTokens["diffContextBg"] {
  if (kind === "add") return theme.diffAddedBg;
  if (kind === "remove") return theme.diffRemovedBg;
  return theme.diffContextBg;
}

type PreviewLine = {
  readonly text: string;
  readonly kind: "text" | "context" | "add" | "remove" | "hunk";
  readonly right?: PreviewLine;
};

/** Truncate and right-pad to exactly `width` display cells so both columns align. */
function fitColumn(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = sliceByColumns(safeText(text), 0, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Column widths for the split preview: two equal halves around a one-cell separator. */
export function splitDiffColumns(width: number): { readonly left: number; readonly right: number } {
  const safeWidth = Math.max(0, Math.floor(width));
  const left = Math.max(0, Math.floor((safeWidth - SPLIT_DIFF_SEPARATOR_WIDTH) / 2));
  return { left, right: Math.max(0, safeWidth - SPLIT_DIFF_SEPARATOR_WIDTH - left) };
}

function splitDiffText(
  cell: { readonly kind: string; readonly number: number | undefined; readonly text: string },
  gutter: number,
  width: number,
): string {
  if (width <= 0) return "";
  if (cell.kind === "empty") return " ".repeat(width);
  const number = cell.number === undefined ? " ".repeat(gutter) : String(cell.number).padStart(gutter, " ");
  const prefix = `${number} `;
  if (width <= prefix.length) return fitColumn(prefix, width);
  const marker = cell.kind === "add" ? "+" : cell.kind === "remove" ? "-" : " ";
  return `${prefix}${fitColumn(`${marker}${cell.text}`, width - prefix.length)}`;
}

function diffCellKind(kind: string): PreviewLine["kind"] {
  if (kind === "add" || kind === "remove" || kind === "hunk") return kind;
  return "context";
}
export function previewLines(value: FilePreview | CommitDiffPreview | undefined, state: ReviewControllerState, width: number): readonly PreviewLine[] {
  if (value === undefined) return [];
  if (value.kind !== "diff") {
    const gutter = String(Math.max(1, value.lines.length)).length;
    return value.lines.map((text, index) => ({
      text: `${String(index + 1).padStart(gutter, " ")} ${text}`,
      kind: "text" as const,
    }));
  }
  if (state.diffLayout !== "split" || width < SPLIT_DIFF_MINIMUM_WIDTH) {
    return value.lines.map(text => ({ text, kind: text.startsWith("@@") ? "hunk" : text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "remove" : "context" }));
  }
  const rows = parseUnifiedDiff(value.lines);
  if (rows === undefined) return value.lines.map(text => ({ text, kind: "context" }));
  const gutter = diffGutterWidth(rows);
  const columns = splitDiffColumns(width);
  return rows.map(row => {
    if (row.kind === "pair") {
      return {
        text: splitDiffText(row.left, gutter, columns.left),
        kind: diffCellKind(row.left.kind),
        right: { text: splitDiffText(row.right, gutter, columns.right), kind: diffCellKind(row.right.kind) },
      };
    }
    return { text: row.text, kind: row.kind === "hunk" ? "hunk" : "context" };
  });
}
export function splitSelectionSpans(
  span: SelectionSpan | undefined,
  leftWidth: number,
  separatorWidth: number,
  rightWidth: number,
): { readonly left: SelectionSpan | undefined; readonly right: SelectionSpan | undefined } {
  if (span === undefined) return { left: undefined, right: undefined };
  const rightStart = leftWidth + separatorWidth;
  return {
    left: span.from < leftWidth && span.to > 0
      ? { row: span.row, from: Math.max(0, span.from), to: Math.min(leftWidth, span.to) }
      : undefined,
    right: span.to > rightStart && span.from < rightStart + rightWidth
      ? { row: span.row, from: Math.max(0, span.from - rightStart), to: Math.min(rightWidth, span.to - rightStart) }
      : undefined,
  };
}

function selectionPieces(line: string, span: SelectionSpan | undefined, width: number): readonly [string, string, string] {
  const plain = safeText(line);
  if (span === undefined) return [plain, "", ""];
  const before = sliceByColumns(plain, 0, span.from);
  const selected = sliceByColumns(plain, span.from, span.to - span.from);
  const after = sliceByColumns(plain, span.to, Math.max(0, width - span.to));
  return [before, selected, after];
}

export function createFilesRouteBindings(handleKey: (key: string) => void) {
  return [
    { key: "up", cmd: () => handleKey("up") }, { key: "down", cmd: () => handleKey("down") },
    { key: "left", cmd: () => handleKey("left") }, { key: "right", cmd: () => handleKey("right") },
    { key: "j", cmd: () => handleKey("j") }, { key: "k", cmd: () => handleKey("k") },
    { key: "h", cmd: () => handleKey("h") }, { key: "l", cmd: () => handleKey("l") },
    { key: "n", cmd: () => handleKey("n") }, { key: "p", cmd: () => handleKey("p") },
    { key: "b", cmd: () => handleKey("b") }, { key: "?", cmd: () => handleKey("?") },
    { key: "enter", cmd: () => handleKey("enter") }, { key: "tab", cmd: () => handleKey("tab") },
    { key: "shift+tab", cmd: () => handleKey("shift+tab") }, { key: "[", cmd: () => handleKey("[") },
    { key: "]", cmd: () => handleKey("]") }, { key: "ctrl+left", cmd: () => handleKey("ctrl+left") },
    { key: "ctrl+right", cmd: () => handleKey("ctrl+right") }, { key: "\\", cmd: () => handleKey("\\") },
    { key: "ctrl+b", cmd: () => handleKey("ctrl+b") }, { key: "d", cmd: () => handleKey("d") },
    { key: "c", cmd: () => handleKey("c") }, { key: "m", cmd: () => handleKey("m") },
    { key: "a", cmd: () => handleKey("a") }, { key: "s", cmd: () => handleKey("s") },
    { key: "v", cmd: () => handleKey("v") },
    { key: "g", cmd: () => handleKey("g") }, { key: "f5", cmd: () => handleKey("f5") },
    { key: "r", cmd: () => handleKey("r") }, { key: "pageup", cmd: () => handleKey("pageup") },
    { key: "pagedown", cmd: () => handleKey("pagedown") }, { key: "home", cmd: () => handleKey("home") },
    { key: "end", cmd: () => handleKey("end") }, { key: "escape", cmd: () => handleKey("escape") },
  ];
}

export interface FilesRouteInputContext {
  readonly getController: () => ReviewController | undefined;
  readonly isDisposed: () => boolean;
  readonly width: () => number;
  readonly viewportHeight: () => number;
  readonly clearSelection: () => void;
  readonly scrollPreview: (delta: number) => void;
  readonly focusTreeOrClose: () => void;
  readonly isHelpVisible: () => boolean;
  readonly toggleHelp: () => void;
}
export function createFilesRouteKeyHandler(context: FilesRouteInputContext): (key: string) => void {
  return (key: string): void => {
    const active = context.getController();
    const state = active?.state;
    if (context.isDisposed() || active === undefined || state === undefined) return;
    // Esc and ? are captured before the help gate so help can always be toggled and closed.
    if (key === "escape") { context.focusTreeOrClose(); return; }
    if (key === "?") { context.toggleHelp(); return; }
    if (context.isHelpVisible()) return;
    if (key === "f5" || key === "r") { context.clearSelection(); active.refresh(); return; }
    if (key === "b") { context.clearSelection(); active.toggleBranches(); return; }
    if (key === "tab" || key === "shift+tab") {
      if (state.treeCollapsed) { context.clearSelection(); active.setTreeCollapsed(false); } else active.toggleFocus();
      return;
    }
    if (key === "\\" || key === "ctrl+b") { context.clearSelection(); active.setTreeCollapsed(!state.treeCollapsed); return; }
    if (key === "d") { context.clearSelection(); active.toggleDiffLayout(); return; }
    if (key === "c") { context.clearSelection(); active.cycleDiffContext(); return; }
    if (key === "[" || key === "ctrl+left") { active.resizeTree(-1, context.width()); return; }
    if (key === "]" || key === "ctrl+right") { active.resizeTree(1, context.width()); return; }
    if (key === "g") { context.clearSelection(); active.toggleLeftMode(); return; }
    if (state.focus === "preview") {
      if (key === "left" || key === "h") active.focusTree();
      else if (key === "home") { active.scrollPreviewHome(context.viewportHeight()); context.clearSelection(); }
      else if (key === "end") { active.scrollPreviewEnd(context.viewportHeight()); context.clearSelection(); }
      else if (key === "up" || key === "k") context.scrollPreview(-1);
      else if (key === "down" || key === "j") context.scrollPreview(1);
      else if (key === "pageup") context.scrollPreview(-context.viewportHeight());
      else if (key === "pagedown") context.scrollPreview(context.viewportHeight());
      return;
    }
    // n/p replace j/k as the primary next/previous keys in files, history, and branches.
    if (state.leftMode === "branches") {
      if (key === "n" || key === "down") { active.movePrimarySelection(1); return; }
      if (key === "p" || key === "up") { active.movePrimarySelection(-1); return; }
      if (key === "enter") { active.switchSelectedBranch(); return; }
      return;
    }
    if (state.leftMode === "log") {
      if (key === "n" || key === "down") { active.movePrimarySelection(1); return; }
      if (key === "p" || key === "up") { active.movePrimarySelection(-1); return; }
      if (key === "enter" || key === "right" || key === "l") { active.focusPreview(); return; }
      return;
    }
    if (key === "a" && state.leftMode === "files") { context.clearSelection(); active.setViewMode("all"); return; }
    if (key === "m" && state.leftMode === "files") { context.clearSelection(); active.setViewMode("modified"); return; }
    if (key === "v" && state.leftMode === "files") { context.clearSelection(); active.toggleListLayout(); return; }
    if (key === "s" && state.leftMode === "files") { context.clearSelection(); active.toggleScope(); return; }
    if (key === "n" || key === "down") { context.clearSelection(); active.movePrimarySelection(1); return; }
    if (key === "p" || key === "up") { context.clearSelection(); active.movePrimarySelection(-1); return; }
    if (key === "left" || key === "h") { context.clearSelection(); active.collapseOrParent(); return; }
    if (key === "right" || key === "l") {
      context.clearSelection();
      const selected = state.rows[state.selectedIndex];
      if (selected?.node.kind === "file") active.focusPreview(); else active.expandOrChild();
      return;
    }
    if (key === "enter") { context.clearSelection(); active.openSelection(); }
  };
}

export type FilesRouteMouseTarget = "divider" | "tree" | "preview" | "ignore";

export function filesRouteMouseTarget(event: MouseEvent, state: ReviewControllerState, width: number): FilesRouteMouseTarget {
  const wide = isWide(width, state);
  const left = wide ? treeWidth(width, state.treeRatio) : 0;
  if (wide && event.x === left) return "divider";
  if (wide && event.x < left || !wide && state.focus === "tree") return "tree";
  if (!wide && state.focus !== "preview") return "ignore";
  return "preview";
}
export function copyFilesRouteSelection(
  selection: PreviewSelection | undefined,
  rows: readonly string[],
  width: number,
  copyToClipboard: (text: string) => boolean,
  warn: () => void,
): string | undefined {
  if (selection === undefined || isEmptySelection(selection)) return undefined;
  const text = selectionText(rows, selection, width);
  if (!copyToClipboard(text)) {
    warn();
    return undefined;
  }
  const lines = text.split("\n").length;
  return `copied ${lines} ${lines === 1 ? "line" : "lines"}`;
}
export function filesRoutePreviewPoint(event: MouseEvent, state: ReviewControllerState, width: number, viewportHeight: number): SelectionPoint | undefined {
  const wide = isWide(width, state);
  const left = wide ? treeWidth(width, state.treeRatio) : 0;
  if (wide && event.x <= left) return undefined;
  if (!wide && state.focus !== "preview") return undefined;
  const previewWidth = Math.max(0, (wide ? width - left : width) - 2);
  const col = event.x - (wide ? left + 1 : 1);
  const row = event.y - BODY_TOP;
  if (row < 0 || row >= viewportHeight || col < 0 || col >= previewWidth) return undefined;
  return { row, col };
}

export interface FilesRouteMouseContext {
  readonly getController: () => ReviewController | undefined;
  readonly isDisposed: () => boolean;
  readonly width: () => number;
  readonly viewportHeight: () => number;
  readonly treeOffset: () => number;
  readonly logOffset: () => number;
  readonly branchOffset: () => number;
  readonly getSelection: () => PreviewSelection | undefined;
  readonly setSelection: (selection: PreviewSelection | undefined) => void;
  readonly isSelectionDrag: () => boolean;
  readonly setSelectionDrag: (active: boolean) => void;
  readonly isDividerDrag: () => boolean;
  readonly setDividerDrag: (active: boolean) => void;
  readonly clearSelection: () => void;
  readonly bumpRevision: () => void;
  readonly copySelection: () => void;
}

export function createFilesRouteMouseHandlers(context: FilesRouteMouseContext): {
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly onMouseDrag: (event: MouseEvent) => void;
  readonly onMouseUp: () => void;
} {
  return {
    onMouseDown: (event: MouseEvent): void => {
      const active = context.getController();
      const state = active?.state;
      if (context.isDisposed() || active === undefined || state === undefined) return;
      const width = context.width();
      const target = filesRouteMouseTarget(event, state, width);
      const bodyRow = event.y - BODY_TOP;
      if (target === "divider") {
        if (bodyRow < 0) return;
        context.clearSelection();
        context.setDividerDrag(true);
        return;
      }
      if (target === "tree") {
        // Overview header and pane-title border rows sit above BODY_TOP; padding below the
        // last visible row sits at or past viewportHeight. Neither selects a row.
        if (bodyRow < 0 || bodyRow >= context.viewportHeight()) return;
        const branchMode = state.leftMode === "branches";
        const offset = state.leftMode === "log" ? context.logOffset() : branchMode ? context.branchOffset() : context.treeOffset();
        const index = offset + bodyRow;
        if (branchMode) {
          // A branch click always selects only — it can never trigger a switch — and must
          // stay within the actual branch list rather than trailing viewport rows.
          const length = state.branches?.branches.length ?? 0;
          if (index < 0 || index >= length) return;
        }
        context.clearSelection();
        active.focusTree();
        active.selectPrimary(index);
        return;
      }
      if (target === "ignore") return;
      const point = filesRoutePreviewPoint(event, state, width, context.viewportHeight());
      if (point === undefined) return;
      active.focusPreview();
      context.clearSelection();
      context.setSelectionDrag(true);
      context.setSelection({ anchor: point, head: point });
      context.bumpRevision();
    },
    onMouseDrag: (event: MouseEvent): void => {
      const active = context.getController();
      const state = active?.state;
      if (context.isDisposed() || active === undefined || state === undefined) return;
      const width = context.width();
      if (context.isDividerDrag() && isWide(width, state)) {
        active.setTreeColumns(event.x, width);
        return;
      }
      const selection = context.getSelection();
      if (!context.isSelectionDrag() || selection === undefined) return;
      const point = filesRoutePreviewPoint(event, state, width, context.viewportHeight());
      if (point === undefined) return;
      context.setSelection({ anchor: selection.anchor, head: point });
      context.bumpRevision();
    },
    onMouseUp: (): void => {
      if (context.isSelectionDrag()) context.copySelection();
      context.setSelectionDrag(false);
      context.setDividerDrag(false);
    },
  };
}

export function FilesRoute(props: FilesRouteProps) {

  const dimensions = useTerminalDimensions();
  const [revision, setRevision] = createSignal(0);
  const [helpVisible, setHelpVisible] = createSignal(false);
  let controller: ReviewController | undefined;
  let disposed = false;
  let popMode: (() => void) | undefined;
  let selection: PreviewSelection | undefined;
  let selectionDrag = false;
  let dividerDrag = false;
  let copyNotice: string | undefined;
  let treeOffset = 0;
  let logOffset = 0;
  let branchOffset = 0;
  let lastPreview: FilePreview | CommitDiffPreview | undefined;
  let lastPreviewPath: string | undefined;
  let lastDimensions: FilesRouteDimensions | undefined;

  const currentState = (): ReviewControllerState | undefined => {
    revision();
    return controller?.state;
  };

  const clearSelection = (): void => {
    selection = undefined;
    selectionDrag = false;
    copyNotice = undefined;
  };

  const viewportHeight = (): number => Math.max(1, dimensions().height - BODY_TOP - FOOTER_ROWS - 1);
  const scrollPreview = (delta: number): void => {
    const active = controller;
    const before = active?.state.previewScroll;
    active?.scrollPreview(delta, viewportHeight());
    if (active?.state.previewScroll !== before) clearSelection();
  };

  const focusTreeOrClose = (): void => {
    // Esc leaves Branches/help/preview first, then closes from the Files tree.
    if (helpVisible()) { setHelpVisible(false); return; }
    const active = controller;
    if (active?.state.focus === "preview") active.focusTree();
    else props.onClose();
  };
  const handleKey = createFilesRouteKeyHandler({
    getController: () => controller,
    isDisposed: () => disposed,
    width: () => dimensions().width,
    viewportHeight,
    clearSelection,
    scrollPreview,
    focusTreeOrClose,
    isHelpVisible: helpVisible,
    toggleHelp: () => setHelpVisible(value => !value),
  });

  useBindings(() => ({
    priority: 100,
    bindings: createFilesRouteBindings(handleKey),
  }));


  const copySelection = (): void => {
    const state = controller?.state;
    if (state === undefined) return;
    const width = isWide(dimensions().width, state)
      ? Math.max(0, dimensions().width - treeWidth(dimensions().width, state.treeRatio) - 2)
      : Math.max(0, dimensions().width - 2);
    const rows = buildPreviewLines(state, width).map(line => previewLineText(line));
    const notice = copyFilesRouteSelection(
      selection,
      rows,
      width,
      text => props.api.renderer.copyToClipboardOSC52(text),
      () => props.api.ui.toast({ variant: "warning", message: "Terminal clipboard copy is unavailable." }),
    );
    if (notice === undefined) return;
    copyNotice = notice;
    setRevision((value: number) => value + 1);
  };
  const mouseHandlers = createFilesRouteMouseHandlers({
    getController: () => controller,
    isDisposed: () => disposed,
    width: () => dimensions().width,
    viewportHeight,
    treeOffset: () => treeOffset,
    logOffset: () => logOffset,
    branchOffset: () => branchOffset,
    getSelection: () => selection,
    setSelection: value => { selection = value; },
    isSelectionDrag: () => selectionDrag,
    setSelectionDrag: value => { selectionDrag = value; },
    isDividerDrag: () => dividerDrag,
    setDividerDrag: value => { dividerDrag = value; },
    clearSelection,
    bumpRevision: () => setRevision((value: number) => value + 1),
    copySelection,
  });
  const onMouseDown = mouseHandlers.onMouseDown;
  const onMouseDrag = mouseHandlers.onMouseDrag;
  const onMouseUp = mouseHandlers.onMouseUp;




  const onMouseScroll = (event: MouseEvent): void => {
    const active = controller;
    const state = active?.state;
    if (disposed || active === undefined || state === undefined || event.scroll === undefined) return;
    const width = dimensions().width;
    const left = isWide(width, state) ? treeWidth(width, state.treeRatio) : 0;
    if ((isWide(width, state) && event.x < left) || (!isWide(width, state) && state.focus === "tree")) {
      clearSelection();
      active.movePrimarySelection(event.scroll.direction === "down" ? WHEEL_STEP : -WHEEL_STEP);
    } else {
      const delta = event.scroll.direction === "down" ? WHEEL_STEP : -WHEEL_STEP;
      scrollPreview(delta);
    }
  };

  const buildPreviewLines = (state: ReviewControllerState, width: number): readonly PreviewLine[] => {
    controller?.setPreviewWidth(width);
    const value = state.leftMode === "log" ? state.commitDiff : state.preview;
    const lines = previewLines(value, state, width);
    const first = Math.max(0, Math.min(state.previewScroll, Math.max(0, lines.length - viewportHeight())));
    return lines.slice(first, first + viewportHeight());
  };

  const previewLineText = (line: PreviewLine): string => line.right === undefined ? line.text : `${line.text}${SPLIT_DIFF_SEPARATOR}${line.right.text}`;
  const renderTextLine = (line: PreviewLine, index: number, width: number) => {
    const span = selection === undefined ? undefined : selectedSpans(selection, index + 1, width).find(item => item.row === index);
    const theme = props.api.theme.current;
    if (line.right !== undefined) {
      const separator = SPLIT_DIFF_SEPARATOR;
      const leftWidth = visibleWidth(line.text);
      const rightWidth = visibleWidth(line.right.text);
      const spans = splitSelectionSpans(span, leftWidth, visibleWidth(separator), rightWidth);
      const leftSpan = spans.left;
      const rightSpan = spans.right;
      // Split cells each carry their own diff background through gutter, marker, and padding.
      const renderSide = (value: string, kind: PreviewLine["kind"], sideSpan: SelectionSpan | undefined) => {
        const fg = diffColor(kind, theme);
        const bg = diffBg(kind, theme);
        if (sideSpan === undefined) return <span style={{ fg, bg }}>{safeText(value)}</span>;
        const [before, selected, after] = selectionPieces(value, sideSpan, visibleWidth(value));
        return <>
          <span style={{ fg, bg }}>{before}</span>
          <span style={{ fg: theme.selectedListItemText, bg: theme.backgroundElement }}>{selected}</span>
          <span style={{ fg, bg }}>{after}</span>
        </>;
      };
      return <text>
        {renderSide(line.text, line.kind, leftSpan)}
        <span style={{ fg: theme.diffContext, bg: theme.diffContextBg }}>{separator}</span>
        {renderSide(line.right.text, line.right.kind, rightSpan)}
      </text>;
    }
    if (line.kind === "text") {
      // Ordinary file preview text keeps the host text token without a diff background mask.
      const text = previewLineText(line);
      const [before, selected, after] = selectionPieces(text, span, width);
      if (span !== undefined) return <text>
        <span style={{ fg: diffColor(line.kind, theme) }}>{before}</span>
        <span style={{ fg: theme.selectedListItemText, bg: theme.backgroundElement }}>{selected}</span>
        <span style={{ fg: diffColor(line.kind, theme) }}>{after}</span>
      </text>;
      return <text content={safeText(text)} fg={diffColor(line.kind, theme)} />;
    }
    // Diff add/remove/context/hunk rows are padded to the full available width before the
    // background mask is applied, so the color fills the row rather than just the glyphs.
    const fg = diffColor(line.kind, theme);
    const bg = diffBg(line.kind, theme);
    const padded = fitColumn(previewLineText(line), width);
    const [before, selected, after] = selectionPieces(padded, span, width);
    if (span !== undefined) return <text>
      <span style={{ fg, bg }}>{before}</span>
      <span style={{ fg: theme.selectedListItemText, bg: theme.backgroundElement }}>{selected}</span>
      <span style={{ fg, bg }}>{after}</span>
    </text>;
    return <text><span style={{ fg, bg }}>{padded}</span></text>;
  };

  const renderPreview = (state: ReviewControllerState | undefined, width: number) => {
    const theme = props.api.theme.current;
    if (state === undefined) return <text content="Loading project files…" fg={theme.primary} />;
    const value = state.leftMode === "log" ? state.commitDiff : state.preview;
    if (state.leftMode === "log" && state.commitDiffLoading && value === undefined) return <text content="Loading commit preview…" fg={theme.primary} />;
    if (state.leftMode !== "log" && state.previewLoading && value === undefined) return <text content="Loading preview…" fg={theme.primary} />;
    if (value === undefined) return <text content={state.leftMode === "log" ? "Select a commit to preview" : "Select a file to preview"} fg={theme.textMuted} />;
    if (value.kind === "binary") return <>
      <text content="Binary file" fg={theme.warning} />
      <Show when={value.byteSize !== undefined}><text content={`${value.byteSize!.toLocaleString("en-US")} bytes`} fg={theme.textMuted} /></Show>
    </>;
    if (value.kind === "error") return <text content={`Error: ${safeText(value.error ?? "Unable to load file")}`} fg={theme.error} />;
    const lines = buildPreviewLines(state, width);
    return <For each={lines}>{(line: PreviewLine, index: () => number) => renderTextLine(line, index(), width)}</For>;
  };

  /** Selected+focused rows get a full-row backgroundElement mask; everything else keeps plain text. */
  const renderRow = (text: string, selected: boolean, focused: boolean, fg: ThemeTokens["text"], width: number) => {
    const theme = props.api.theme.current;
    if (selected && focused) {
      return <text><span style={{ fg: theme.selectedListItemText, bg: theme.backgroundElement }}>{fitColumn(text, width)}</span></text>;
    }
    return <text content={text} fg={fg} />;
  };

  const renderTree = (state: ReviewControllerState | undefined, width: number) => {
    const theme = props.api.theme.current;
    if (state === undefined) return <text content="Loading project files…" fg={theme.primary} />;
    if (state.leftMode === "log") {
      if (state.historyLoading && state.history === undefined) return <text content="Loading history…" fg={theme.primary} />;
      if (state.historyError !== undefined) return <text content={`Error: ${safeText(state.historyError)}`} fg={theme.error} />;
      const entries = state.history?.entries ?? [];
      if (entries.length === 0) return <text content="No commits found" fg={theme.textMuted} />;
      if (state.logSelectedIndex < logOffset) logOffset = state.logSelectedIndex;
      if (state.logSelectedIndex >= logOffset + viewportHeight()) logOffset = state.logSelectedIndex - viewportHeight() + 1;
      return <For each={entries.slice(logOffset, logOffset + viewportHeight())}>{(entry: GitLogEntry, offset: () => number) => {
        const index = logOffset + offset();
        const selected = index === state.logSelectedIndex;
        const text = `${selected ? ">" : " "} ${safeText(entry.shortOid)} ${safeText(entry.subject)}`;
        return renderRow(text, selected, state.focus === "tree", theme.text, width);
      }}</For>;
    }
    if (state.leftMode === "branches") {
      if (state.branchLoading && state.branches === undefined) return <text content="Loading branches…" fg={theme.primary} />;
      if (state.branchError !== undefined) return <text content={`Error: ${safeText(state.branchError)}`} fg={theme.error} />;
      const branches = state.branches?.branches ?? [];
      if (branches.length === 0) return <text content="No local branches found" fg={theme.textMuted} />;
      if (state.branchSelectedIndex < branchOffset) branchOffset = state.branchSelectedIndex;
      if (state.branchSelectedIndex >= branchOffset + viewportHeight()) branchOffset = state.branchSelectedIndex - viewportHeight() + 1;
      return <For each={branches.slice(branchOffset, branchOffset + viewportHeight())}>{(branch: GitBranch, offset: () => number) => {
        const index = branchOffset + offset();
        const selected = index === state.branchSelectedIndex;
        const switching = state.branchSwitching === branch.name;
        const text = `${selected ? ">" : " "} ${branch.current ? "* " : "  "}${safeText(branch.name)}${switching ? " (switching…)" : ""}`;
        return renderRow(text, selected, state.focus === "tree", branch.current ? theme.success : theme.text, width);
      }}</For>;
    }
    if (state.snapshot === undefined) return <text content={state.refreshError === undefined ? "Loading project files…" : `Error: ${safeText(state.refreshError)}`} fg={state.refreshError === undefined ? theme.primary : theme.error} />;
    if (state.rows.length === 0) {
      const message = state.snapshot.kind === "filesystem" ? "No project files found" : state.viewMode === "modified" ? `No ${state.scope} changes — press a for all files` : "No project files found";
      return <text content={message} fg={theme.textMuted} />;
    }
    if (state.selectedIndex < treeOffset) treeOffset = state.selectedIndex;
    if (state.selectedIndex >= treeOffset + viewportHeight()) treeOffset = state.selectedIndex - viewportHeight() + 1;
    return <For each={state.rows.slice(treeOffset, treeOffset + viewportHeight())}>{(row: TreeRow, offset: () => number) => {
      const index = treeOffset + offset();
      const selected = index === state.selectedIndex;
      const node = row.node;
      if (node.kind === "section") {
        const label = `── ${safeText(node.name)} `;
        return <text content={`${label}${"─".repeat(Math.max(0, width - label.length))}`} fg={theme.textMuted} />;
      }
      const cursor = selected ? ">" : " ";
      const indent = "  ".repeat(row.depth);
      const text = node.kind === "directory"
        ? `${cursor} ${indent}${row.expanded ? "▼" : "▶"} ${safeText(node.name)}/`
        : `${cursor} ${indent}${node.status ?? " "}  ${safeText(node.name)}`;
      return renderRow(text, selected, state.focus === "tree", statusColor(node.status, theme), width);
    }}</For>;
  };

  const footer = (state: ReviewControllerState | undefined): string => {
    if (state === undefined) return "loading";
    const project = state.snapshot;
    const summary = summaryFor(project, state.scope);
    const pieces: string[] = [];
    if (state.leftMode === "log" && state.commitDiff?.truncated) pieces.push("commit preview truncated");
    else if (state.leftMode === "log" && state.history?.truncated) pieces.push("history truncated");
    else if (state.preview?.truncated) pieces.push("preview truncated");
    else if (project?.truncated) pieces.push("listing truncated");
    if (project?.kind === "filesystem") pieces.push("filesystem", `${summary.files} ${summary.files === 1 ? "file" : "files"}`);
    else pieces.push(state.viewMode, state.scope, `+${summary.insertions} -${summary.deletions}`, `${summary.files} ${summary.files === 1 ? "file" : "files"}`);
    if (state.refreshLoading) pieces.push("refreshing");
    else if (state.refreshError !== undefined) pieces.push(`error: ${safeText(state.refreshError)}`);
    else if (state.watchError !== undefined) pieces.push(`watch error: ${safeText(state.watchError)}`);
    else if (state.leftMode === "branches" && state.branchError !== undefined) pieces.push(`error: ${safeText(state.branchError)}`);
    else if (state.leftMode === "branches" && state.branchSwitching !== undefined) pieces.push(`switching to ${safeText(state.branchSwitching)}`);
    else if (state.leftMode === "branches" && state.branchLoading) pieces.push("loading branches");
    else if (state.leftMode === "log" && state.historyLoading) pieces.push("loading history");
    else if (state.leftMode === "log" && state.commitDiffLoading) pieces.push("loading commit");
    else if (state.previewLoading) pieces.push("loading preview");
    else if (project?.baselineEstablishedAt !== undefined) pieces.push(`baseline ${new Date(project.baselineEstablishedAt).toISOString()}`);
    if (copyNotice !== undefined) pieces.push(copyNotice);
    const activePreview = state.leftMode === "log" ? state.commitDiff : state.preview;
    if (activePreview?.kind === "diff") pieces.push(`${state.diffLayout} diff`, `ctx ${diffContextLabel(state.diffContext)}`);
    return pieces.join(" · ");
  };

  const source = props.createSource(props.cwd);
  controller = new ReviewController({
    cwd: props.cwd,
    source,
    treeRatio: DEFAULT_PANEL_SETTINGS.treeRatio,
    onTreeRatioChange: props.settings.saveTreeRatio,
    treeCollapsed: DEFAULT_PANEL_SETTINGS.treeCollapsed,
    onTreeCollapsedChange: props.settings.saveTreeCollapsed,
    diffLayout: DEFAULT_PANEL_SETTINGS.diffLayout,
    onDiffLayoutChange: props.settings.saveDiffLayout,
    diffContext: DEFAULT_PANEL_SETTINGS.diffContext,
    onDiffContextChange: props.settings.saveDiffContext,
    highlightTheme: DEFAULT_PANEL_SETTINGS.highlightTheme,
    onHighlightThemeChange: props.settings.saveHighlightTheme,
    onChange: () => {
      if (disposed) return;
      setRevision(controller?.state.revision ?? 0);
      props.api.renderer.requestRender();
    },
  });
  onMount(async () => {
    popMode = props.api.mode.push("pi-lazygit.files");
    controller?.start();
    setRevision(controller?.state.revision ?? 0);
    let restored = DEFAULT_PANEL_SETTINGS;
    try {
      restored = await props.settings.load();
    } catch {
      restored = DEFAULT_PANEL_SETTINGS;
    }
    if (disposed || controller === undefined) return;
    if (restored.treeCollapsed !== controller.state.treeCollapsed) controller.setTreeCollapsed(restored.treeCollapsed);
    if (restored.diffLayout !== controller.state.diffLayout) controller.toggleDiffLayout();
    while (restored.diffContext !== controller.state.diffContext) controller.cycleDiffContext();
    if (restored.highlightTheme !== controller.state.highlightTheme) controller.setHighlightTheme(restored.highlightTheme);
    if (restored.treeRatio !== controller.state.treeRatio) {
      const available = Math.max(0, dimensions().width - 3);
      controller.setTreeColumns(Math.round(available * restored.treeRatio), dimensions().width);
    }
  });

  // The flattened tree lists directories before files, so the very first row after the initial
  // refresh can be a directory. Land the default selection (and its preview) on the first
  // changed file instead, so opening Files immediately shows a preview.
  let initialFileSelectionApplied = false;
  createEffect(() => {
    const state = currentState();
    if (initialFileSelectionApplied || disposed || state === undefined || state.leftMode !== "files" || state.snapshot === undefined) return;
    initialFileSelectionApplied = true;
    const selected = state.rows[state.selectedIndex];
    if (selected?.node.kind === "file") return;
    const fileIndex = state.rows.findIndex(row => row.node.kind === "file");
    if (fileIndex >= 0) controller?.selectPrimary(fileIndex);
  });

  onCleanup(() => {
    disposed = true;
    controller?.dispose();
    controller = undefined;
    popMode?.();
    popMode = undefined;
    void props.settings.flush();
  });

  const renderBody = () => {
    const state = currentState();
    const currentDimensions = { width: dimensions().width, height: dimensions().height };
    if (routeDimensionsChanged(lastDimensions, currentDimensions)) clearSelection();
    lastDimensions = currentDimensions;
    const width = currentDimensions.width;
    // Only the preview that the active mode actually shows retires the selection; comparing
    // the inactive one would clear the selection on every render.
    const activePreview = state?.leftMode === "log" ? state.commitDiff : state?.preview;
    if (activePreview !== lastPreview || state?.previewPath !== lastPreviewPath) {
      selection = undefined;
      selectionDrag = false;
      lastPreview = activePreview;
      lastPreviewPath = state?.previewPath;
    }
    const wide = isWide(width, state);
    const left = wide ? treeWidth(width, state!.treeRatio) : width;
    const previewWidth = wide ? Math.max(0, width - left - 2) : Math.max(0, width - 2);
    return <box flexDirection="row" flexGrow={1} width="100%" onMouseDown={onMouseDown} onMouseDrag={onMouseDrag} onMouseUp={onMouseUp} onMouseDragEnd={onMouseUp} onMouseScroll={onMouseScroll}>
      <Show when={wide} fallback={<box width="100%" height="100%" border borderStyle="single" borderColor={props.api.theme.current.borderActive} title={state?.focus === "preview" ? previewTitle(state!) : treeTitle(state)} overflow="hidden">
        <Show when={state?.focus === "preview"} fallback={renderTree(state, Math.max(0, width - 2))}>{renderPreview(state, previewWidth)}</Show>
      </box>}>
        <box width={left} height="100%" border borderStyle="single" borderColor={state?.focus === "tree" ? props.api.theme.current.borderActive : props.api.theme.current.border} title={treeTitle(state)} overflow="hidden">
          {renderTree(state, Math.max(0, left - 2))}
        </box>
        <box flexGrow={1} height="100%" border borderStyle="single" borderColor={state?.focus === "preview" ? props.api.theme.current.borderActive : props.api.theme.current.border} title={previewTitle(state!)} overflow="hidden">
          {renderPreview(state, previewWidth)}
        </box>
      </Show>
    </box>;
  };

  /** Host-neutral projection consumed by the shared presentation module for titles and actions. */
  const buildPresentationInput = (state: ReviewControllerState | undefined): PanelPresentationInput => {
    const project = state?.snapshot;
    const selectedRow = state?.leftMode === "files" ? state.rows[state.selectedIndex] : undefined;
    const selectedPath = state?.previewPath ?? (selectedRow?.node.kind === "file" ? selectedRow.node.path : undefined);
    const selectedSummary = selectedPath === undefined ? undefined : project?.workspaceSummaryByPath.get(selectedPath);
    // exactOptionalPropertyTypes forbids assigning `undefined` to an optional key directly, so
    // optional fields are only included when they actually have a value. The current branch is
    // also omitted from the overview meta while Branches mode is active: the branch list already
    // marks the current branch, and the overview row would otherwise repeat its name above the
    // list in a way that reads as redundant chrome rather than list content.
    const showCurrentBranch = state?.leftMode !== "branches";
    return {
      sourceKind: project?.kind,
      leftMode: state?.leftMode ?? "files",
      focus: state?.focus ?? "tree",
      viewMode: state?.viewMode ?? "modified",
      scope: state?.scope ?? "workspace",
      ...(!showCurrentBranch || project?.currentBranch === undefined ? {} : { currentBranch: project.currentBranch }),
      ...(!showCurrentBranch || project?.detachedAt === undefined ? {} : { detachedAt: project.detachedAt }),
      fileCount: summaryFor(project, state?.scope ?? "workspace").files,
      ...(selectedPath === undefined ? {} : { selectedPath }),
      ...(selectedSummary === undefined ? {} : { selectedSummary }),
      status: footer(state),
    };
  };

  const renderOverview = () => {
    const state = currentState();
    const theme = props.api.theme.current;
    const project = state?.snapshot;
    const selectedRow = state?.leftMode === "files" ? state.rows[state.selectedIndex] : undefined;
    const selectedPath = state?.previewPath ?? (selectedRow?.node.kind === "file" ? selectedRow.node.path : undefined);
    const selectedSummary = selectedPath === undefined ? undefined : project?.workspaceSummaryByPath.get(selectedPath);
    const presentation = panelPresentation(buildPresentationInput(state));
    const summarySuffix = selectedSummary === undefined ? "" : ` +${selectedSummary.insertions} -${selectedSummary.deletions}`;
    return <box height={1} width="100%" overflow="hidden" flexDirection="row" justifyContent="space-between">
      <text content={presentation.overviewTitle} fg={theme.text} />
      <text content={`${presentation.overviewMeta}${summarySuffix}`} fg={theme.textMuted} />
    </box>;
  };

  const renderFooter = () => {
    const state = currentState();
    const theme = props.api.theme.current;
    const presentation = panelPresentation(buildPresentationInput(state));
    const actionsText = presentation.actions.map(action => `${action.key} ${action.label}`).join("  ");
    // Contextual actions lead the row so they survive width truncation; decorative status
    // metadata (baseline timestamps, counts) trails and may be clipped first.
    const text = actionsText.length > 0 ? `${actionsText}  ${footer(state)}` : footer(state);
    return <box height={1} width="100%" overflow="hidden"><text content={text} fg={theme.textMuted} /></box>;
  };

  const renderHelp = () => {
    const theme = props.api.theme.current;
    return <box width="100%" height="100%" flexDirection="column" border borderStyle="single" borderColor={theme.borderActive} title="Help" overflow="hidden">
      <For each={PANEL_HELP_GROUPS}>{(group: { readonly title: string; readonly actions: readonly { readonly key: string; readonly label: string }[] }) => <box flexDirection="column">
        <text content={group.title} fg={theme.primary} />
        <For each={group.actions}>{(action: { readonly key: string; readonly label: string }) => <text content={`${action.key}  ${action.label}`} fg={theme.text} />}</For>
      </box>}</For>
    </box>;
  };

  return <box width="100%" height="100%" flexDirection="column" backgroundColor={props.api.theme.current.background}>
    {(() => renderOverview()) as unknown as JSX.Element}
    {(() => (helpVisible() ? renderHelp() : renderBody())) as unknown as JSX.Element}
    {(() => renderFooter()) as unknown as JSX.Element}
  </box>;
}
