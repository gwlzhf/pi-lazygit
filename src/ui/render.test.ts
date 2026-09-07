import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
  fitCell,
  renderDiffLine,
  renderNumberedLine,
  renderSingleBorder,
  renderSingleRow,
  renderSplitBorder,
  renderSplitRow,
  sanitizeTerminalText,
} from "./render";

function plainTheme(calls: ThemeColor[] = []): Theme {
  return {
    fg(color: ThemeColor, text: string): string {
      calls.push(color);
      return text;
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
    const calls: ThemeColor[] = [];
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
      "toolDiffAdded",
      "toolDiffRemoved",
      "toolDiffContext",
    ]);
    for (const line of rendered) expectFits(line, 32);
  });

  test("does not mistake added or removed content for file headers", () => {
    const calls: ThemeColor[] = [];
    const theme = plainTheme(calls);

    renderDiffLine("---not-a-header", 24, theme);
    renderDiffLine("+++not-a-header", 24, theme);
    renderDiffLine("---\told/path", 24, theme);
    renderDiffLine("+++\tnew/path", 24, theme);

    expect(calls).toEqual([
      "toolDiffRemoved",
      "toolDiffAdded",
      "toolTitle",
      "toolTitle",
    ]);
  });

  test("sanitizes before styling and handles tiny widths", () => {
    const calls: string[] = [];
    const theme = {
      fg(_color: ThemeColor, text: string): string {
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
});
