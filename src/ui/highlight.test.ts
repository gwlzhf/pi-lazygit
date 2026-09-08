import { expect, test } from "bun:test";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_HIGHLIGHT_THEME,
  getHighlightThemeLabel,
  HIGHLIGHT_THEMES,
  isHighlightThemeName,
  loadHighlighter,
} from "./highlight";

const THEMES = {
  "dark-catppuccin": { name: "catppuccin" } as unknown as Theme,
  "dark-nord": { name: "nord" } as unknown as Theme,
  "dark-tokyo-night": { name: "tokyo-night" } as unknown as Theme,
} as const;

test("exposes the fixed theme catalog and default", () => {
  expect(HIGHLIGHT_THEMES.map(theme => theme.name)).toEqual([
    "catppuccin",
    "nord",
    "tokyo-night",
  ]);
  expect(DEFAULT_HIGHLIGHT_THEME).toBe("catppuccin");
  expect(getHighlightThemeLabel("tokyo-night")).toBe("Tokyo Night");
  expect(isHighlightThemeName("nord")).toBe(true);
  expect(isHighlightThemeName("unknown")).toBe(false);
});

test("loads each OMP theme once and forwards the selected theme", async () => {
  const themeLoads: string[] = [];
  const highlightCalls: Array<readonly [string, string | undefined, Theme | undefined]> = [];
  const highlight = await loadHighlighter({
    getLanguageFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : undefined),
    getThemeByName: async (name: string) => {
      themeLoads.push(name);
      return THEMES[name as keyof typeof THEMES];
    },
    highlightCode: (code: string, language?: string, theme?: Theme) => {
      highlightCalls.push([code, language, theme]);
      return code.split("\n").map(line => `<${line}>`);
    },
  });

  expect(themeLoads).toEqual([
    "dark-catppuccin",
    "dark-nord",
    "dark-tokyo-night",
  ]);
  expect(highlight?.("a", "app.ts", "catppuccin")).toEqual(["<a>"]);
  expect(highlight?.("b", "app.ts", "nord")).toEqual(["<b>"]);
  expect(highlight?.("c", "app.ts", "tokyo-night")).toEqual(["<c>"]);
  expect(highlightCalls).toEqual([
    ["a", "typescript", THEMES["dark-catppuccin"]],
    ["b", "typescript", THEMES["dark-nord"]],
    ["c", "typescript", THEMES["dark-tokyo-night"]],
  ]);
});

test("reports no highlighting for unknown languages and tokenizer failures", async () => {
  const highlight = await loadHighlighter({
    getLanguageFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : undefined),
    getThemeByName: async (name: string) => THEMES[name as keyof typeof THEMES],
    highlightCode: () => {
      throw new Error("tokenizer unavailable");
    },
  });

  expect(highlight?.("a", "notes.unknown", "catppuccin")).toBeUndefined();
  expect(highlight?.("a", "app.ts", "catppuccin")).toBeUndefined();
});

test("disables highlighting when a built-in theme cannot load", async () => {
  const missing = await loadHighlighter({
    getLanguageFromPath: () => "typescript",
    getThemeByName: async (name: string) => (
      name === "dark-nord" ? undefined : THEMES[name as keyof typeof THEMES]
    ),
    highlightCode: (code: string) => [code],
  });
  const rejected = await loadHighlighter({
    getLanguageFromPath: () => "typescript",
    getThemeByName: async () => {
      throw new Error("theme loader unavailable");
    },
    highlightCode: (code: string) => [code],
  });

  expect(missing).toBeUndefined();
  expect(rejected).toBeUndefined();
});
