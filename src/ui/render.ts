import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { DiffCell, DiffRow } from "./diff-view";

const OSC_SEQUENCE = /(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c)/gu;
const STRING_SEQUENCE = /(?:\x1b[P_X^]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c)/gu;
const CSI_SEQUENCE = /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_SEQUENCE = /\x1b[ -/]*[0-~]/gu;
const UNSAFE_CONTROLS = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu;
const ANSI_RESET = "\x1b[0m";

export type BorderEdge = "top" | "bottom";

/** Convert untrusted terminal text into inert printable text with normalized newlines. */
export function sanitizeTerminalText(text: string): string {
  return replaceTabs(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replaceAll("\x1b", "")
    .replace(UNSAFE_CONTROLS, "");
}

/** Truncate and right-pad trusted, single-line text to exactly width display cells. */
export function fitCell(text: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  const oneLine = replaceTabs(text.replaceAll("\r", " ").replaceAll("\n", " "));
  const clipped = truncateToWidth(oneLine, safeWidth, "");
  return clipped + " ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
}

function safeLine(text: string): string {
  return sanitizeTerminalText(text).replaceAll("\n", " ");
}

function themedBorder(theme: Theme, text: string): string {
  return theme.fg("borderMuted", text);
}

function borderSegment(title: string, width: number, theme: Theme): string {
  if (width <= 0) return "";
  const horizontal = "─";
  const cleanTitle = safeLine(title);
  if (cleanTitle.length === 0) return themedBorder(theme, horizontal.repeat(width));

  const prefix = themedBorder(theme, `${horizontal} `);
  const label = theme.fg("accent", cleanTitle);
  const suffix = themedBorder(theme, " ");
  const titled = `${prefix}${label}${suffix}`;
  if (visibleWidth(titled) >= width) return truncateToWidth(titled, width, "");
  return titled + themedBorder(theme, horizontal.repeat(width - visibleWidth(titled)));
}

export function renderSingleBorder(
  title: string,
  width: number,
  edge: BorderEdge,
  theme: Theme,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  const left = edge === "top" ? "┌" : "└";
  const right = edge === "top" ? "┐" : "┘";
  if (safeWidth === 1) return themedBorder(theme, left);
  const row = `${themedBorder(theme, left)}${borderSegment(title, safeWidth - 2, theme)}${themedBorder(theme, right)}`;
  return truncateToWidth(row, safeWidth, "");
}

export function renderSplitBorder(
  leftTitle: string,
  rightTitle: string,
  width: number,
  leftWidth: number,
  edge: BorderEdge,
  theme: Theme,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth < 3) return renderSingleBorder(`${leftTitle} ${rightTitle}`, safeWidth, edge, theme);
  const safeLeftWidth = Math.max(0, Math.min(Math.floor(leftWidth), safeWidth - 3));
  const rightWidth = safeWidth - safeLeftWidth - 3;
  const left = edge === "top" ? "┌" : "└";
  const divider = edge === "top" ? "┬" : "┴";
  const right = edge === "top" ? "┐" : "┘";
  const row = [
    themedBorder(theme, left),
    borderSegment(leftTitle, safeLeftWidth, theme),
    themedBorder(theme, divider),
    borderSegment(rightTitle, rightWidth, theme),
    themedBorder(theme, right),
  ].join("");
  return truncateToWidth(row, safeWidth, "");
}

export function renderSingleRow(content: string, width: number, theme: Theme): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (safeWidth === 1) return fitCell(content, 1);
  return `${themedBorder(theme, "│")}${fitCell(content, safeWidth - 2)}${themedBorder(theme, "│")}`;
}

export function renderSplitRow(
  left: string,
  right: string,
  width: number,
  leftWidth: number,
  theme: Theme,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth < 3) return fitCell(`${left}${right}`, safeWidth);
  const safeLeftWidth = Math.max(0, Math.min(Math.floor(leftWidth), safeWidth - 3));
  const rightWidth = safeWidth - safeLeftWidth - 3;
  const border = themedBorder(theme, "│");
  return `${border}${fitCell(left, safeLeftWidth)}${border}${fitCell(right, rightWidth)}${border}`;
}

function diffColor(line: string): ThemeColor {
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("--- ") ||
    line.startsWith("---\t") ||
    line.startsWith("+++ ") ||
    line.startsWith("+++\t")
  ) {
    return "toolTitle";
  }
  if (line.startsWith("@@")) return "accent";
  if (line.startsWith("+")) return "toolDiffAdded";
  if (line.startsWith("-")) return "toolDiffRemoved";
  return "toolDiffContext";
}

export function renderDiffLine(line: string, width: number, theme: Theme): string {
  const clean = safeLine(line);
  const cell = fitCell(clean, width);
  return theme.fg(diffColor(clean), cell);
}

/** Smallest preview width that still fits two readable diff columns. */
export const SPLIT_DIFF_MINIMUM_WIDTH = 40;

function diffCellColor(kind: DiffCell["kind"]): ThemeColor {
  if (kind === "add") return "toolDiffAdded";
  if (kind === "remove") return "toolDiffRemoved";
  return "toolDiffContext";
}

function renderDiffCell(cell: DiffCell, width: number, theme: Theme, gutterWidth: number): string {
  if (width <= 0) return "";
  // Padding opposite an unpaired removal or addition: blank, but still filled so
  // the column separator stays aligned.
  if (cell.kind === "empty") return theme.fg("dim", " ".repeat(width));
  const number = (cell.number === undefined ? "" : String(cell.number)).padStart(Math.max(1, gutterWidth));
  const numberWidth = visibleWidth(number);
  if (width <= numberWidth) return theme.fg("dim", fitCell(number, width));
  const marker = cell.kind === "add" ? "+" : cell.kind === "remove" ? "-" : " ";
  const body = fitCell(`${marker}${safeLine(cell.text)}`, width - numberWidth - 1);
  return `${theme.fg("dim", `${number} `)}${theme.fg(diffCellColor(cell.kind), body)}`;
}

/**
 * Render one side-by-side diff row: the old file left, the new file right, and
 * hunk or file headers across the full width.
 */
export function renderDiffSplitRow(
  row: DiffRow,
  width: number,
  theme: Theme,
  gutterWidth: number,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (row.kind !== "pair") return renderDiffLine(row.text, safeWidth, theme);
  if (safeWidth < 3) return theme.fg("dim", " ".repeat(safeWidth));
  const leftWidth = Math.floor((safeWidth - 1) / 2);
  const rightWidth = safeWidth - 1 - leftWidth;
  return [
    renderDiffCell(row.left, leftWidth, theme, gutterWidth),
    themedBorder(theme, "│"),
    renderDiffCell(row.right, rightWidth, theme, gutterWidth),
  ].join("");
}

export function renderNumberedLine(
  line: string,
  lineNumber: number,
  width: number,
  theme: Theme,
  gutterWidth = String(Math.max(1, lineNumber)).length,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  const number = String(Math.max(1, Math.floor(lineNumber))).padStart(Math.max(1, gutterWidth));
  if (safeWidth <= visibleWidth(number)) {
    return theme.fg("dim", fitCell(number, safeWidth));
  }
  const prefix = theme.fg("dim", `${number} `);
  const bodyWidth = safeWidth - visibleWidth(prefix);
  return `${prefix}${theme.fg("text", fitCell(safeLine(line), bodyWidth))}`;
}

/**
 * Render one syntax-highlighted source line. Unlike {@link renderNumberedLine}
 * this keeps the escape sequences in `line`, so callers must pass text that was
 * sanitized before it was colored — never raw file content.
 */
export function renderHighlightedLine(
  line: string,
  lineNumber: number,
  width: number,
  theme: Theme,
  gutterWidth = String(Math.max(1, lineNumber)).length,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  const number = String(Math.max(1, Math.floor(lineNumber))).padStart(Math.max(1, gutterWidth));
  if (safeWidth <= visibleWidth(number)) {
    return theme.fg("dim", fitCell(number, safeWidth));
  }
  const prefix = theme.fg("dim", `${number} `);
  const bodyWidth = safeWidth - visibleWidth(prefix);
  // Truncation can cut a color sequence off from its terminator, so close the
  // line explicitly instead of letting a color bleed into the panel border.
  return `${prefix}${fitCell(line, bodyWidth)}${ANSI_RESET}`;
}
