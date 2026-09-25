import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { parseUnifiedDiff, type DiffRow } from "./diff-view";
import {
  fitCell,
  renderDiffLine,
  renderDiffSplitRow,
  renderWrappedDiffLine,
  renderWrappedDiffSplitRow,
  renderHighlightedLine,
  renderNumberedLine,
  renderSelectedRow,
  renderSingleBorder,
  renderSingleRow,
  renderSplitBorder,
  renderSplitRow,
  sanitizeTerminalText,
} from "./render";

/** An older OMP runtime: `fg` and `bg` exist, `fgOnBg` does not. */
function legacyTheme(calls: string[] = []): Theme {
  return {
    fg(color: ThemeColor, text: string): string {
      calls.push(color);
      return text;
    },
    bg(background: string, text: string): string {
      calls.push(`bg:${background}`);
      return text;
    },
  } as unknown as Theme;
}

function plainTheme(calls: string[] = []): Theme {
  return {
    fg(color: ThemeColor, text: string): string {
      calls.push(color);
      return text;
    },
    bg(background: string, text: string): string {
      calls.push(`/${background}`);
      return text;
    },
    fgOnBg(color: ThemeColor, background: string, text: string): string {
      calls.push(`${color}/${background}`);
      return text;
    },
  } as unknown as Theme;
}

function modernTheme(isLight: boolean): Theme {
  return {
    isLight,
    fg(_color: ThemeColor, text: string): string {
      return text;
    },
    bg(_background: string, text: string): string {
      return text;
    },
    fgOnBg(_color: ThemeColor, _background: string, text: string): string {
      return text;
    },
    getBgHex(background: string): string {
      return background === "toolSuccessBg" ? "#208040" : "#802020";
    },
    getBgAnsi(background: string): string {
      return background === "toolSuccessBg"
        ? "\x1b[48;2;32;128;64m"
        : "\x1b[48;2;128;32;32m";
    },
  } as unknown as Theme;
}

function expectFits(line: string, width: number): void {
  expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe("sanitizeTerminalText", () => {
  test("normalizes line boundaries, expands tabs, and removes terminal controls", () => {
    expect(
      sanitizeTerminalText(
        "a\r\nb\rc\t\x1b[31mred\x1b[0m\x1b]0;title\x07\0end",
      ),
    ).toBe("a\nb\nc   redend");
  });

  test("removes string and two-byte escape sequences instead of exposing their payload", () => {
    expect(
      sanitizeTerminalText(
        "start\x1bPdevice command\x1b\\middle\x1b7end\u0085",
      ),
    ).toBe("startmiddleend");
  });
});

describe("width-safe cells", () => {
  test("fits ASCII, CJK, combining text, tabs, and sanitized escape input at widths 1 through 120", () => {
    const values = [
      "plain text",
      "文件/猫.ts",
      "e\u0301cole",
      "tab\tvalue",
      sanitizeTerminalText("bad\x1b[2Jname\x00"),
    ];

    for (let width = 1; width <= 120; width += 1) {
      for (const value of values) {
        const line = fitCell(sanitizeTerminalText(value).replaceAll("\n", " "), width);
        expectFits(line, width);
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  test("composes exact single and split borders and rows", () => {
    const theme = plainTheme();
    const lines = [
      renderSingleBorder("Tree", 12, "top", theme),
      renderSingleRow("猫", 12, theme),
      renderSplitBorder("Tree", "Diff", 20, 7, "top", theme),
      renderSplitRow("猫", "abc", 20, 7, theme),
      renderSingleBorder("ready", 12, "bottom", theme),
    ];

    expect(lines).toEqual([
      "┌─ Tree ───┐",
      "│猫        │",
      "┌─ Tree ┬─ Diff ───┐",
      "│猫     │abc       │",
      "└─ ready ──┘",
    ]);
    for (const [index, width] of [12, 12, 20, 20, 12].entries()) {
      expectFits(lines[index] ?? "", width);
    }
  });

  test("border composition stays safe for every supported width", () => {
    const theme = plainTheme();
    for (let width = 1; width <= 120; width += 1) {
      const leftWidth = Math.max(0, Math.floor((width - 3) * 0.42));
      const lines = [
        renderSingleBorder("文件 \x1b[31m", width, "top", theme),
        renderSingleRow("e\u0301\t猫", width, theme),
        renderSplitBorder("Tree", "Diff", width, leftWidth, "top", theme),
        renderSplitRow("left", "right", width, leftWidth, theme),
      ];
      for (const line of lines) expectFits(line, width);
    }
  });
});

describe("preview line rendering", () => {
  test("uses file, hunk, addition, deletion, then context precedence", () => {
    const calls: string[] = [];
    const theme = plainTheme(calls);
    const source = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "+added",
      "-removed",
      " context",
    ];

    const rendered = source.map(line => renderDiffLine(line, 32, theme));

    expect(calls).toEqual([
      "toolTitle",
      "toolTitle",
      "toolTitle",
      "accent",
      "toolDiffAdded/toolSuccessBg",
      "toolDiffRemoved/toolErrorBg",
      "toolDiffContext",
    ]);
    for (const line of rendered) expectFits(line, 32);
  });

  test("does not mistake added or removed content for file headers", () => {
    const calls: string[] = [];
    const theme = plainTheme(calls);

    renderDiffLine("---not-a-header", 24, theme);
    renderDiffLine("+++not-a-header", 24, theme);
    renderDiffLine("---\told/path", 24, theme);
    renderDiffLine("+++\tnew/path", 24, theme);

    expect(calls).toEqual([
      "toolDiffRemoved/toolErrorBg",
      "toolDiffAdded/toolSuccessBg",
      "toolTitle",
      "toolTitle",
    ]);
  });

  test("wraps long unified and split changes without losing CJK cells or color", () => {
    const calls: string[] = [];
    const theme = plainTheme(calls);
    const unified = renderWrappedDiffLine("+猫猫abcdefgh", 5, theme);
    expect(unified).toEqual(["+猫猫", "abcde", "fgh  "]);
    expect(calls).toEqual([
      "toolDiffAdded/toolSuccessBg",
      "toolDiffAdded/toolSuccessBg",
      "toolDiffAdded/toolSuccessBg",
    ]);

    const row = parseUnifiedDiff(["@@ -1 +1 @@", "-old-abcdefghij", "+new-1234567890"])?.[1];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const split = renderWrappedDiffSplitRow(row, 21, theme, 1);
    expect(split.length).toBeGreaterThan(1);
    expect(split.map(line => line.split("│")[0]?.slice(3).trim()).join("")).toBe("old-abcdefghij");
    expect(split.map(line => line.split("│")[1]?.slice(3).trim()).join("")).toBe("new-1234567890");
    for (const line of split) expect(visibleWidth(line)).toBe(21);
  });

  test("uses deeper green and red for changed lines on light and dark themes", () => {
    for (const isLight of [true, false]) {
      const theme = { ...plainTheme(), isLight } as Theme;
      const added = renderDiffLine("+new", 8, theme);
      const removed = renderDiffLine("-old", 8, theme);
      expect(added).toContain(isLight ? "\x1b[38;2;37;114;74m" : "\x1b[38;2;67;156;106m");
      expect(removed).toContain(isLight ? "\x1b[38;2;177;45;48m" : "\x1b[38;2;225;82;82m");
      expect(added).toEndWith("\x1b[39m");
      expect(removed).toEndWith("\x1b[39m");
    }
  });

  test("paints opacity-adjusted modern masks and covers split gutters", () => {
    const theme = modernTheme(true);
    const half = renderDiffLine("+x", 4, theme, undefined, 0.5);
    expect(half).toContain("\x1b[48;2;144;192;160m");
    expect(half).not.toContain("\x1b[48;2;32;128;64m");

    const opaque = renderDiffLine("+x", 4, theme, undefined, 1);
    expect(opaque).toContain("\x1b[48;2;32;128;64m");
    expect(opaque).toEndWith("\x1b[49m");

    const row = parseUnifiedDiff(["@@ -1 +1 @@", "-old", "+new"])?.[1];
    expect(row?.kind).toBe("pair");
    if (row?.kind !== "pair") return;
    const split = renderDiffSplitRow(row, 21, theme, 1, 0.5);
    expect(split).toContain("\x1b[48;2;192;144;144m");
    expect(sanitizeTerminalText(split)).toContain("1 -old");
    expect(sanitizeTerminalText(split)).toContain("1 +new");
    expect(visibleWidth(split)).toBe(21);
  });

  test("sanitizes before styling and handles tiny widths", () => {
    const calls: string[] = [];
    const theme = {
      fg(_color: ThemeColor, text: string): string {
        calls.push(text);
        return text;
      },
      fgOnBg(_color: ThemeColor, _background: string, text: string): string {
        calls.push(text);
        return text;
      },
    } as unknown as Theme;

    for (let width = 1; width <= 120; width += 1) {
      const lines = [
        renderDiffLine("+猫\t\x1b[2Jboom\0", width, theme),
        renderNumberedLine("e\u0301\t猫\x1b]0;title\x07", 7, width, theme, 2),
      ];
      for (const line of lines) {
        expectFits(line, width);
        expect(line).not.toContain("\x1b");
        expect(line).not.toContain("\0");
      }
    }
    expect(calls.every(text => !text.includes("\x1b") && !text.includes("\0"))).toBe(true);
  });

  test("renders exact numbered rows with a stable gutter", () => {
    const theme = plainTheme();
    const lines = [
      renderNumberedLine("alpha", 1, 12, theme, 2),
      renderNumberedLine("猫\tbeta", 12, 12, theme, 2),
    ];

    expect(lines).toEqual([" 1 alpha    ", "12 猫   beta"]);
    for (const line of lines) expectFits(line, 12);
  });

  test("renders side-by-side rows with numbered, marked columns", () => {
    const theme = plainTheme();
    const rows = parseUnifiedDiff(["@@ -1,2 +1,2 @@", " keep", "-old", "+new"]) ?? [];

    const rendered = rows.map(row => renderDiffSplitRow(row, 21, theme, 1));

    expect(rendered).toEqual([
      "@@ -1,2 +1,2 @@      ",
      "1  keep   │1  keep   ",
      "2 -old    │2 +new    ",
    ]);
    for (const line of rendered) expectFits(line, 21);
  });

  test("blanks the column that has no counterpart and colors each side", () => {
    const calls: string[] = [];
    const theme = plainTheme(calls);
    const rows = parseUnifiedDiff(["@@ -1 +1,2 @@", "-old", "+new", "+extra"]) ?? [];

    const rendered = rows.slice(1).map(row => renderDiffSplitRow(row, 21, theme, 1));

    expect(rendered).toEqual([
      "1 -old    │1 +new    ",
      "          │2 +extra  ",
    ]);
    expect(calls).toEqual([
      "dim",
      "toolDiffRemoved/toolErrorBg",
      "borderMuted",
      "dim",
      "toolDiffAdded/toolSuccessBg",
      "dim",
      "borderMuted",
      "dim",
      "toolDiffAdded/toolSuccessBg",
    ]);
  });

  test("sanitizes split cells and stays width safe at every width", () => {
    const theme = plainTheme();
    const rows: readonly DiffRow[] = parseUnifiedDiff([
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-猫\t\x1b[2Jold\0",
      "+new",
    ]) ?? [];

    for (let width = 1; width <= 120; width += 1) {
      for (const row of rows) {
        const line = renderDiffSplitRow(row, width, theme, 3);
        expectFits(line, width);
        expect(line).not.toContain("\x1b[2J");
        expect(line).not.toContain("\0");
      }
    }
  });

  test("keeps unified and split diff masks exact-width under ANSI, CJK, and combining text", () => {
    const theme = plainTheme();
    const rows: readonly DiffRow[] = parseUnifiedDiff([
      "@@ -1 +1 @@",
      "-e\u0301 猫\x1b[31mold\x1b[0m",
      "+e\u0301 文件\x1b[32mnew\x1b[0m",
    ]) ?? [];

    for (let width = 1; width <= 80; width += 1) {
      const unified = renderDiffLine("+e\u0301 文件\x1b[32mnew\x1b[0m", width, theme);
      expect(visibleWidth(unified)).toBe(width);
      for (const row of rows) {
        const split = renderDiffSplitRow(row, width, theme, 2);
        expect(visibleWidth(split)).toBe(width);
      }
    }
  });

  test("falls back to fg over bg on hosts whose theme has no fgOnBg", () => {
    const calls: string[] = [];
    const theme = legacyTheme(calls);

    // These crashed with "theme.fgOnBg is not a function" on OMP 18.0.3.
    expect(renderSelectedRow("src/a.ts", 12, theme)).toBe("src/a.ts    ");
    expect(renderDiffLine("+added", 8, theme)).toBe("+added  ");
    expect(renderDiffLine("-gone", 8, theme)).toBe("-gone   ");
    const rows = parseUnifiedDiff(["@@ -1 +1 @@", "-old", "+new"]) ?? [];
    const pair = rows.find(value => value.kind === "pair") as DiffRow;
    expect(visibleWidth(renderDiffSplitRow(pair, 24, theme, 1))).toBe(24);

    expect(calls).toContain("bg:selectedBg");
    expect(calls).toContain("bg:toolSuccessBg");
    expect(calls).toContain("bg:toolErrorBg");
  });

  test("keeps highlight colors, closes them, and stays width safe", () => {
    const theme = plainTheme();
    const colored = "\x1b[35mconst\x1b[39m x";

    expect(renderHighlightedLine(colored, 1, 14, theme, 2)).toBe(" 1 \x1b[35mconst\x1b[39m x    \x1b[0m");
    // A truncated row still ends with a reset, so no color reaches the border.
    expect(renderHighlightedLine(colored, 1, 8, theme, 2)).toBe(" 1 \x1b[35mconst\x1b[0m\x1b[0m");
    expect(renderHighlightedLine(colored, 7, 2, theme, 2)).toBe(" 7");

    for (let width = 1; width <= 120; width += 1) {
      const line = renderHighlightedLine(colored, 42, width, theme, 3);
      expectFits(line, width);
      expect(line.endsWith("\x1b[0m") || width <= 3).toBe(true);
    }
  });
});
