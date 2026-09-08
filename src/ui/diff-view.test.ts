import { describe, expect, test } from "bun:test";
import { diffGutterWidth, parseUnifiedDiff, type DiffRow } from "./diff-view";

function pairs(rows: readonly DiffRow[]): string[] {
  return rows.map(row =>
    row.kind === "pair"
      ? `${row.left.number ?? ""}${row.left.kind === "empty" ? "" : row.left.text}|${row.right.number ?? ""}${row.right.kind === "empty" ? "" : row.right.text}`
      : `<${row.kind}> ${row.text}`
  );
}

describe("parseUnifiedDiff", () => {
  test("numbers context lines and pairs a removal block with the additions after it", () => {
    const rows = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -4,5 +4,5 @@ function demo() {",
      " keep one",
      "-old one",
      "-old two",
      "+new one",
      " keep two",
    ]);

    expect(rows).toBeDefined();
    expect(pairs(rows ?? [])).toEqual([
      "<meta> diff --git a/src/a.ts b/src/a.ts",
      "<meta> index 1111111..2222222 100644",
      "<meta> --- a/src/a.ts",
      "<meta> +++ b/src/a.ts",
      "<hunk> @@ -4,5 +4,5 @@ function demo() {",
      "4keep one|4keep one",
      "5old one|5new one",
      "6old two|",
      "7keep two|6keep two",
    ]);
  });

  test("keeps the columns aligned when a side has no counterpart", () => {
    const rows = parseUnifiedDiff([
      "@@ -1,1 +1,3 @@",
      " kept",
      "+added one",
      "+added two",
    ]) ?? [];

    expect(pairs(rows)).toEqual([
      "<hunk> @@ -1,1 +1,3 @@",
      "1kept|1kept",
      "|2added one",
      "|3added two",
    ]);
    const [, , unpaired] = rows;
    expect(unpaired).toMatchObject({ left: { kind: "empty", number: undefined } });
  });

  test("restarts the counters on each hunk and each file of a multi-file diff", () => {
    const rows = parseUnifiedDiff([
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -40,1 +41,1 @@",
      "-c",
      "+d",
      "diff --git a/second.ts b/second.ts",
      "@@ -7 +7 @@",
      "-e",
      "+f",
    ]) ?? [];

    expect(pairs(rows)).toEqual([
      "<hunk> @@ -1 +1 @@",
      "1a|1b",
      "<hunk> @@ -40,1 +41,1 @@",
      "40c|41d",
      "<meta> diff --git a/second.ts b/second.ts",
      "<hunk> @@ -7 +7 @@",
      "7e|7f",
    ]);
  });

  test("holds the no-newline marker until the surrounding block is paired", () => {
    const rows = parseUnifiedDiff([
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ]) ?? [];

    expect(pairs(rows)).toEqual([
      "<hunk> @@ -1 +1 @@",
      "1old|1new",
      "<meta> \\ No newline at end of file",
      "<meta> \\ No newline at end of file",
    ]);
  });

  test("treats a blank body line as empty context on both sides", () => {
    const rows = parseUnifiedDiff(["@@ -1,2 +1,2 @@", "", "-x", "+y"]) ?? [];

    expect(pairs(rows)).toEqual(["<hunk> @@ -1,2 +1,2 @@", "1|1", "2x|2y"]);
  });

  test("rejects combined merge diffs so callers keep the unified rendering", () => {
    expect(parseUnifiedDiff(["@@@ -1,1 -1,1 +1,1 @@@", "- a", " +b"])).toBeUndefined();
  });

  test("sizes the gutter from the widest line number", () => {
    expect(diffGutterWidth([])).toBe(1);
    const rows = parseUnifiedDiff(["@@ -998,3 +1,3 @@", " a", " b", " c"]) ?? [];
    expect(diffGutterWidth(rows)).toBe(4);
  });
});
