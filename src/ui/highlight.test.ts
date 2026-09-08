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
const PI_THEME = { name: "pi" } as unknown as Theme;

test("exposes the fixed theme catalog and default", () => {
  expect(HIGHLIGHT_THEMES.map(theme => theme.name)).toEqual([
    "pi",
    "catppuccin",
    "nord",
    "tokyo-night",
  ]);
  expect(DEFAULT_HIGHLIGHT_THEME).toBe("pi");
  expect(getHighlightThemeLabel("pi")).toBe("Pi");
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
  expect(highlight?.("a", "app.ts", "pi", PI_THEME)).toEqual(["<a>"]);
  expect(highlight?.("b", "app.ts", "catppuccin", PI_THEME)).toEqual(["<b>"]);
  expect(highlight?.("c", "app.ts", "nord", PI_THEME)).toEqual(["<c>"]);
  expect(highlight?.("d", "app.ts", "tokyo-night", PI_THEME)).toEqual(["<d>"]);
  expect(highlightCalls).toEqual([
    ["a", "typescript", PI_THEME],
    ["b", "typescript", THEMES["dark-catppuccin"]],
    ["c", "typescript", THEMES["dark-nord"]],
    ["d", "typescript", THEMES["dark-tokyo-night"]],
  ]);
});

test("warms native grammars while loading themes", async () => {
  let warmCalls = 0;

  await loadHighlighter({
    getLanguageFromPath: () => "typescript",
    getThemeByName: async (name: string) => THEMES[name as keyof typeof THEMES],
    highlightCode: (code: string) => [code],
    warmHighlighter: async () => {
      warmCalls += 1;
    },
  });

  expect(warmCalls).toBe(1);
});

test("creates a stateful stream with the selected language and theme", async () => {
  const streamCalls: Array<readonly [string | undefined, Theme | undefined]> = [];
  const pushed: string[] = [];
  const highlight = await loadHighlighter({
    getLanguageFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : undefined),
    getThemeByName: async (name: string) => THEMES[name as keyof typeof THEMES],
    highlightCode: (code: string) => [code],
    createHighlightStream: (language: string | undefined, theme?: Theme) => {
      streamCalls.push([language, theme]);
      return {
        push(chunk: string): string {
          pushed.push(chunk);
          return `<${chunk}>`;
        },
      };
    },
  });

  const stream = highlight?.createStream?.("app.ts", "nord", PI_THEME);

  expect(stream?.push("const x = 1;\n")).toBe("<const x = 1;\n>");
  expect(streamCalls).toEqual([["typescript", THEMES["dark-nord"]]]);
  expect(pushed).toEqual(["const x = 1;\n"]);
});

test("reports no highlighting for unknown languages and tokenizer failures", async () => {
  const highlight = await loadHighlighter({
    getLanguageFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : undefined),
    getThemeByName: async (name: string) => THEMES[name as keyof typeof THEMES],
    highlightCode: () => {
      throw new Error("tokenizer unavailable");
    },
  });

  expect(highlight?.("a", "notes.unknown", "pi", PI_THEME)).toBeUndefined();
  expect(highlight?.("a", "app.ts", "pi", PI_THEME)).toBeUndefined();
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
