/**
 * Mouse text selection for the preview pane.
 *
 * Terminal mouse tracking is on while the panel is open, so the terminal's own
 * selection is unavailable. The panel therefore tracks a drag of its own over
 * the rendered preview rows, paints it with reverse video, and copies the
 * selected text to the system clipboard with OSC 52 on release.
 */

import { sliceByColumn, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeTerminalText } from "./render";

const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const ANSI_RESET = "\x1b[0m";

/** A point inside the preview viewport: 0-based row and column of the pane. */
export interface SelectionPoint {
  readonly row: number;
  readonly col: number;
}

/** A drag in progress or finished, in preview viewport coordinates. */
export interface PreviewSelection {
  readonly anchor: SelectionPoint;
  readonly head: SelectionPoint;
}

/** Order the drag endpoints so `start` precedes `end` in reading order. */
export function orderSelection(selection: PreviewSelection): {
  readonly start: SelectionPoint;
  readonly end: SelectionPoint;
} {
  const { anchor, head } = selection;
  const headFirst = head.row < anchor.row || (head.row === anchor.row && head.col < anchor.col);
  return headFirst ? { start: head, end: anchor } : { start: anchor, end: head };
}

/** Whether the drag never left its origin cell, so nothing is selected. */
export function isEmptySelection(selection: PreviewSelection): boolean {
  return selection.anchor.row === selection.head.row && selection.anchor.col === selection.head.col;
}

function padTo(text: string, width: number): string {
  const missing = Math.max(0, width - visibleWidth(text));
  return missing === 0 ? text : text + " ".repeat(missing);
}

/** Columns of `row` the selection covers, or `undefined` when it covers none. */
function rowRange(
  selection: PreviewSelection,
  row: number,
  width: number,
): { readonly from: number; readonly to: number } | undefined {
  const { start, end } = orderSelection(selection);
  if (row < start.row || row > end.row) return undefined;
  const from = row === start.row ? start.col : 0;
  // The cell under the pointer is part of the selection, as it is in a terminal's
  // own selection, so the end column is inclusive.
  const to = row === end.row ? Math.min(width, end.col + 1) : width;
  return to <= from ? undefined : { from, to };
}

/**
 * Paint the selected columns of the already styled preview rows with reverse
 * video. Rows outside the selection are returned untouched.
 */
export function highlightSelection(
  rows: readonly string[],
  selection: PreviewSelection,
  width: number,
): readonly string[] {
  if (isEmptySelection(selection) || width <= 0) return rows;
  return rows.map((row, index) => {
    const range = rowRange(selection, index, width);
    if (range === undefined) return row;
    const head = padTo(sliceByColumn(row, 0, range.from), range.from);
    const body = padTo(sliceByColumn(row, range.from, range.to - range.from), range.to - range.from);
    const tail = sliceByColumn(row, range.to, Math.max(0, width - range.to));
    return `${head}${REVERSE_ON}${body}${REVERSE_OFF}${tail}${ANSI_RESET}`;
  });
}

/**
 * The plain text the selection covers, one line per row with the row padding
 * trimmed. Styling is stripped so the clipboard receives source text only.
 */
export function selectionText(
  rows: readonly string[],
  selection: PreviewSelection,
  width: number,
): string {
  if (isEmptySelection(selection) || width <= 0) return "";
  const { start, end } = orderSelection(selection);
  const parts: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const range = rowRange(selection, row, width);
    const line = rows[row];
    if (range === undefined || line === undefined) {
      parts.push("");
      continue;
    }
    const plain = sanitizeTerminalText(line).replaceAll("\n", " ");
    parts.push(sliceByColumn(plain, range.from, range.to - range.from).trimEnd());
  }
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts.join("\n");
}

/**
 * An OSC 52 clipboard write. Terminals that support it copy `text` into the
 * system clipboard, including across SSH; terminals that do not ignore it.
 */
export function encodeOsc52(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${encoded}\x07`;
}
