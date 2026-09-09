import { describe, expect, test } from "bun:test";
import {
  encodeOsc52,
  highlightSelection,
  isEmptySelection,
  orderSelection,
  selectionText,
  type PreviewSelection,
} from "./selection";

function selection(
  anchorRow: number,
  anchorCol: number,
  headRow: number,
  headCol: number,
): PreviewSelection {
  return { anchor: { row: anchorRow, col: anchorCol }, head: { row: headRow, col: headCol } };
}

describe("orderSelection", () => {
  test("puts the earlier point first regardless of drag direction", () => {
    expect(orderSelection(selection(2, 4, 1, 9)).start).toEqual({ row: 1, col: 9 });
    expect(orderSelection(selection(1, 9, 1, 2)).start).toEqual({ row: 1, col: 2 });
    expect(orderSelection(selection(1, 2, 1, 9)).end).toEqual({ row: 1, col: 9 });
  });

  test("reports a drag that never moved as empty", () => {
    expect(isEmptySelection(selection(1, 4, 1, 4))).toBe(true);
    expect(isEmptySelection(selection(1, 4, 1, 5))).toBe(false);
  });
});

describe("selectionText", () => {
  const rows = ["1 alpha   ", "2 bravo   ", "3 charlie "];

  test("includes the cell under the pointer and trims row padding", () => {
    expect(selectionText(rows, selection(0, 2, 0, 6), 10)).toBe("alpha");
    expect(selectionText(rows, selection(0, 0, 0, 9), 10)).toBe("1 alpha");
  });

  test("takes whole rows between the first and last row", () => {
    expect(selectionText(rows, selection(0, 2, 2, 4), 10)).toBe("alpha\n2 bravo\n3 cha");
  });

  test("reads a backwards drag the same as a forwards one", () => {
    expect(selectionText(rows, selection(2, 4, 0, 2), 10)).toBe("alpha\n2 bravo\n3 cha");
  });

  test("returns nothing for an empty drag", () => {
    expect(selectionText(rows, selection(1, 3, 1, 3), 10)).toBe("");
  });

  test("strips styling so only source text reaches the clipboard", () => {
    expect(selectionText(["\x1b[31m1 alpha\x1b[0m"], selection(0, 2, 0, 6), 10)).toBe("alpha");
  });
});

describe("highlightSelection", () => {
  test("wraps only the selected columns in reverse video", () => {
    const [row] = highlightSelection(["1 alpha   "], selection(0, 2, 0, 6), 10);
    expect(row).toBe("1 \x1b[7malpha\x1b[27m   \x1b[0m");
  });

  test("leaves unselected rows untouched", () => {
    const rows = highlightSelection(["one", "two"], selection(0, 0, 0, 1), 3);
    expect(rows[1]).toBe("two");
  });

  test("returns the rows unchanged for an empty drag", () => {
    const rows = ["one"];
    expect(highlightSelection(rows, selection(0, 1, 0, 1), 3)).toBe(rows);
  });
});

describe("encodeOsc52", () => {
  test("emits a base64 clipboard write", () => {
    expect(encodeOsc52("alpha")).toBe("\x1b]52;c;YWxwaGE=\x07");
  });

  test("encodes non-ASCII text as UTF-8", () => {
    expect(encodeOsc52("猫")).toBe(`\x1b]52;c;${Buffer.from("猫", "utf8").toString("base64")}\x07`);
  });
});
