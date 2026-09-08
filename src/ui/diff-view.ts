/**
 * Unified-diff to side-by-side model.
 *
 * `git diff` output is a single column: removals and additions interleave and
 * only the hunk header carries line numbers. The split preview needs the old
 * and new files as two aligned columns, so this module replays the hunk line
 * counters and pairs each block of removals with the additions that follow it.
 * Parsing stays free of terminal concerns; {@link ../ui/render} colors the rows.
 */

export type DiffCellKind = "context" | "add" | "remove" | "empty";

export interface DiffCell {
  readonly kind: DiffCellKind;
  /** Line number in the old (left) or new (right) file; absent when padding. */
  readonly number: number | undefined;
  readonly text: string;
}

export type DiffRow =
  /** File headers and `\ No newline at end of file`, spanning both columns. */
  | { readonly kind: "meta"; readonly text: string }
  /** A `@@ … @@` hunk header, spanning both columns. */
  | { readonly kind: "hunk"; readonly text: string }
  | { readonly kind: "pair"; readonly left: DiffCell; readonly right: DiffCell };

const EMPTY_CELL: DiffCell = { kind: "empty", number: undefined, text: "" };
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Convert unified diff lines into side-by-side rows, or report `undefined` when
 * the input is not a plain two-way unified diff — combined merge diffs number
 * more than two files per hunk, and those keep the unified rendering.
 */
export function parseUnifiedDiff(lines: readonly string[]): readonly DiffRow[] | undefined {
  const rows: DiffRow[] = [];
  let removals: DiffCell[] = [];
  let additions: DiffCell[] = [];
  let notes: string[] = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let inHunk = false;

  function flush(): void {
    const paired = Math.max(removals.length, additions.length);
    for (let index = 0; index < paired; index += 1) {
      rows.push({
        kind: "pair",
        left: removals[index] ?? EMPTY_CELL,
        right: additions[index] ?? EMPTY_CELL,
      });
    }
    for (const note of notes) rows.push({ kind: "meta", text: note });
    removals = [];
    additions = [];
    notes = [];
  }

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      const match = HUNK_HEADER.exec(line);
      const rawLeft = match?.[1];
      const rawRight = match?.[2];
      if (rawLeft === undefined || rawRight === undefined) return undefined;
      leftNumber = Number.parseInt(rawLeft, 10);
      rightNumber = Number.parseInt(rawRight, 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      removals.push({ kind: "remove", number: leftNumber, text: line.slice(1) });
      leftNumber += 1;
      continue;
    }
    if (line.startsWith("+")) {
      additions.push({ kind: "add", number: rightNumber, text: line.slice(1) });
      rightNumber += 1;
      continue;
    }
    // `\ No newline at end of file` annotates the line before it, so it is held
    // back until the surrounding removal/addition block has been paired.
    if (line.startsWith("\\")) {
      notes.push(line);
      continue;
    }
    if (line.startsWith(" ") || line.length === 0) {
      flush();
      const text = line.slice(1);
      rows.push({
        kind: "pair",
        left: { kind: "context", number: leftNumber, text },
        right: { kind: "context", number: rightNumber, text },
      });
      leftNumber += 1;
      rightNumber += 1;
      continue;
    }
    // Anything else ends the hunk — typically the next file's `diff --git`.
    flush();
    inHunk = false;
    rows.push({ kind: "meta", text: line });
  }

  flush();
  return rows;
}

/** Digits needed by the widest line number, so both columns align. */
export function diffGutterWidth(rows: readonly DiffRow[]): number {
  let widest = 0;
  for (const row of rows) {
    if (row.kind !== "pair") continue;
    widest = Math.max(widest, row.left.number ?? 0, row.right.number ?? 0);
  }
  return String(Math.max(1, widest)).length;
}
