import type { Theme, ThemeBg, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import {
  DEFAULT_DIFF_MASK_OPACITY,
  normalizeDiffMaskOpacity,
} from "../contracts";
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

/** Deeper green/red than the host's pastel diff palette, contrasted on light themes. */
function diffText(theme: Theme, color: ThemeColor, text: string): string {
  if (color !== "toolDiffAdded" && color !== "toolDiffRemoved") return theme.fg(color, text);
  if (typeof theme.isLight !== "boolean") return theme.fg(color, text);
  const rgb = color === "toolDiffAdded"
    ? theme.isLight ? "37;114;74" : "67;156;106"
    : theme.isLight ? "177;45;48" : "225;82;82";
  return `\x1b[38;2;${rgb}m${text}\x1b[39m`;
}

/**
 * `Theme.fgOnBg` only exists in newer OMP runtimes. Older hosts still expose
 * `fg` and `bg`, so compose the same result there instead of crashing the panel.
 */
function fgOnBg(theme: Theme, color: ThemeColor, background: ThemeBg, text: string): string {
  if (typeof theme.fgOnBg === "function") return theme.fgOnBg(color, background, text);
  if (typeof theme.bg === "function") return theme.bg(background, theme.fg(color, text));
  return theme.fg(color, text);
}

type ThemeMaskApi = Theme & {
  getBgHex?: (background: ThemeBg) => string;
  getBgAnsi?: (background: ThemeBg) => string;
};

function parseHexColor(value: string): readonly [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/iu.exec(value);
  if (match === null) return undefined;
  const digits = match[1] ?? "";
  if (digits.length === 3) {
    return [
      Number.parseInt(`${digits[0]}${digits[0]}`, 16),
      Number.parseInt(`${digits[1]}${digits[1]}`, 16),
      Number.parseInt(`${digits[2]}${digits[2]}`, 16),
    ];
  }
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

/** Paint an opacity-adjusted RGB background when the modern Theme API is available. */
function modernDiffMask(
  theme: Theme,
  background: ThemeBg,
  text: string,
  opacity: number,
): string | undefined {
  const api = theme as ThemeMaskApi;
  if (
    typeof theme.isLight !== "boolean" ||
    typeof api.getBgHex !== "function" ||
    typeof api.getBgAnsi !== "function"
  ) {
    return undefined;
  }
  try {
    const original = parseHexColor(api.getBgHex(background));
    const backgroundAnsi = api.getBgAnsi(background);
    if (original === undefined) return opacity >= 1 ? `${backgroundAnsi}${text}\x1b[49m` : undefined;
    const base = theme.isLight ? 255 : 0;
    const rgb = original.map(channel => Math.round(base + (channel - base) * opacity));
    const ansi = opacity >= 1
      ? backgroundAnsi
      : `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    return `${ansi}${text}\x1b[49m`;
  } catch {
    return undefined;
  }
}


function maskedDiffText(
  theme: Theme,
  color: ThemeColor,
  background: ThemeBg,
  text: string,
  opacity = DEFAULT_DIFF_MASK_OPACITY,
): string {
  const styled = typeof theme.isLight === "boolean" ? diffText(theme, color, text) : text;
  const modern = modernDiffMask(
    theme,
    background,
    styled,
    normalizeDiffMaskOpacity(opacity) ?? DEFAULT_DIFF_MASK_OPACITY,
  );
  if (modern !== undefined) return modern;
  return fgOnBg(theme, color, background, styled);
}

export function renderDiffLine(
  line: string,
  width: number,
  theme: Theme,
  color?: ThemeColor,
  opacity = DEFAULT_DIFF_MASK_OPACITY,
): string {
  const clean = safeLine(line);
  const cell = fitCell(clean, width);
  const resolvedColor = color ?? diffColor(clean);
  if (resolvedColor === "toolDiffAdded") {
    return maskedDiffText(theme, resolvedColor, "toolSuccessBg", cell, opacity);
  }
  if (resolvedColor === "toolDiffRemoved") {
    return maskedDiffText(theme, resolvedColor, "toolErrorBg", cell, opacity);
  }
  return diffText(theme, resolvedColor, cell);
}

/** Visual rows for a diff line, retaining the original line's color on continuations. */
export function renderWrappedDiffLine(
  line: string,
  width: number,
  theme: Theme,
  opacity = DEFAULT_DIFF_MASK_OPACITY,
): readonly string[] {
  if (width <= 0) return [];
  const clean = safeLine(line);
  const color = diffColor(clean);
  return wrapTextWithAnsi(clean, width).map(fragment => renderDiffLine(fragment, width, theme, color, opacity));
}

/** Smallest preview width that still fits two readable diff columns. */
export const SPLIT_DIFF_MINIMUM_WIDTH = 40;

function diffCellColor(kind: DiffCell["kind"]): ThemeColor {
  if (kind === "add") return "toolDiffAdded";
  if (kind === "remove") return "toolDiffRemoved";
  return "toolDiffContext";
}

function renderDiffCell(
  cell: DiffCell,
  width: number,
  theme: Theme,
  gutterWidth: number,
  opacity = DEFAULT_DIFF_MASK_OPACITY,
): string {
  if (width <= 0) return "";
  // Padding opposite an unpaired removal or addition: blank, but still filled so
  // the column separator stays aligned.
  if (cell.kind === "empty") return theme.fg("dim", " ".repeat(width));
  const number = (cell.number === undefined ? "" : String(cell.number)).padStart(Math.max(1, gutterWidth));
  const numberWidth = visibleWidth(number);
  if (width <= numberWidth) return theme.fg("dim", fitCell(number, width));
  const marker = cell.kind === "add" ? "+" : cell.kind === "remove" ? "-" : " ";
  const body = fitCell(`${marker}${safeLine(cell.text)}`, width - numberWidth - 1);
  const color = diffCellColor(cell.kind);
  const dimPrefix = theme.fg("dim", `${number} `);
  if (cell.kind === "context") return `${dimPrefix}${diffText(theme, color, body)}`;
  const background = cell.kind === "add" ? "toolSuccessBg" : "toolErrorBg";
  const styled = typeof theme.isLight === "boolean" ? diffText(theme, color, body) : body;
  const normalizedOpacity = normalizeDiffMaskOpacity(opacity) ?? DEFAULT_DIFF_MASK_OPACITY;
  const modern = modernDiffMask(theme, background, `${dimPrefix}${styled}`, normalizedOpacity);
  if (modern !== undefined) return modern;
  // Apply the legacy background to the entire cell, including its gutter and
  // trailing padding. The nested dim escape keeps line numbers subdued.
  return fgOnBg(theme, color, background, `${dimPrefix}${styled}`);
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
  opacity = DEFAULT_DIFF_MASK_OPACITY,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (row.kind !== "pair") return renderDiffLine(row.text, safeWidth, theme, undefined, opacity);
  if (safeWidth < 3) return theme.fg("dim", " ".repeat(safeWidth));
  const leftWidth = Math.floor((safeWidth - 1) / 2);
  const rightWidth = safeWidth - 1 - leftWidth;
  return [
    renderDiffCell(row.left, leftWidth, theme, gutterWidth, opacity),
    themedBorder(theme, "│"),
    renderDiffCell(row.right, rightWidth, theme, gutterWidth, opacity),
  ].join("");
}

/** Pad trusted, single-line text to width, then paint the whole row as selected. */
export function renderSelectedRow(text: string, width: number, theme: Theme): string {
  return fgOnBg(theme, "text", "selectedBg", fitCell(text, width));
}

/** Wrap both sides independently while keeping corresponding fragments aligned. */
export function renderWrappedDiffSplitRow(
  row: DiffRow,
  width: number,
  theme: Theme,
  gutterWidth: number,
  opacity = DEFAULT_DIFF_MASK_OPACITY,
): readonly string[] {
  if (width <= 0) return [];
  if (row.kind !== "pair") return renderWrappedDiffLine(row.text, width, theme, opacity);
  const leftWidth = Math.floor((width - 1) / 2);
  const rightWidth = width - 1 - leftWidth;
  if (leftWidth <= gutterWidth + 2 || rightWidth <= gutterWidth + 2) {
    return [renderDiffSplitRow(row, width, theme, gutterWidth, opacity)];
  }
  const left = row.left.kind === "empty"
    ? [""]
    : wrapTextWithAnsi(safeLine(row.left.text), leftWidth - gutterWidth - 2);
  const right = row.right.kind === "empty"
    ? [""]
    : wrapTextWithAnsi(safeLine(row.right.text), rightWidth - gutterWidth - 2);
  const count = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const leftText = left[index];
    const rightText = right[index];
    lines.push(renderDiffSplitRow({
      kind: "pair",
      left: leftText === undefined
        ? { kind: "empty", number: undefined, text: "" }
        : { ...row.left, number: index === 0 ? row.left.number : undefined, text: leftText },
      right: rightText === undefined
        ? { kind: "empty", number: undefined, text: "" }
        : { ...row.right, number: index === 0 ? row.right.number : undefined, text: rightText },
    }, width, theme, gutterWidth, opacity));
  }
  return lines;
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
