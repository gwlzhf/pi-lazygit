import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { renderCommitDialog } from "./commit-dialog";

function theme(): Theme {
  return {
    fg(_color: ThemeColor, text: string): string { return text; },
    bg(_background: string, text: string): string { return text; },
    fgOnBg(_color: ThemeColor, _background: string, text: string): string { return text; },
    bold(text: string): string { return text; },
  } as unknown as Theme;
}

describe("commit dialog rendering", () => {
  test("renders input, controls, and sanitized multiline Git output at narrow and wide widths", () => {
    for (const width of [1200, 640, 480]) {
      const rows = renderCommitDialog({
        title: "Confirm commit",
        lines: ["Branch: main", "file one\nfile two", "\u001b[31munsafe\u001b[0m"],
        input: "update title",
      }, width, theme());
      expect(rows.join("\n")).toContain("file one");
      expect(rows.join("\n")).toContain("file two");
      expect(rows.join("\n")).not.toContain("\u001b[31m");
      expect(rows.join("\n")).toContain("Ctrl+N no-verify");
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  test("confirmation state exposes distinct continuation and cancellation keys", () => {
    const rows = renderCommitDialog({ title: "Review push", lines: ["ahead 1 · behind 0"] }, 480, theme());
    expect(rows.join("\n")).toContain("y continue");
    expect(rows.join("\n")).toContain("n/Esc cancel");
  });
  test("renders stage-specific instructions and a cursor in protected branch input", () => {
    const rows = renderCommitDialog({
      title: "Confirm remote write",
      lines: ["Type main then Enter"],
      input: "mai",
      inputCursor: 2,
      inputLabel: "Branch",
      footer: "Type exact branch + Enter · Esc cancel",
    }, 40, theme());
    expect(rows.join("\n")).toContain("Branch: ma_i");
    expect(rows.join("\n")).toContain("Type exact branch + Enter");
    expect(rows.join("\n")).not.toContain("y continue");
  });
});
