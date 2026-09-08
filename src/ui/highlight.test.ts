import { expect, test } from "bun:test";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { loadHighlighter } from "./highlight";

const THEME = { name: "test-theme" } as unknown as Theme;

test("highlights through the injected host module", async () => {
  const calls: Array<readonly [string, string | undefined, Theme | undefined]> = [];
  const highlight = await loadHighlighter({
    getLanguageFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : undefined),
    highlightCode: (code: string, language?: string, theme?: Theme) => {
      calls.push([code, language, theme]);
      return code.split("\n").map(line => `<${line}>`);
    },
  });

  expect(highlight?.("a\nb", "app.ts", THEME)).toEqual(["<a>", "<b>"]);
  // The theme carries the syntax colors, so it must reach the highlighter.
  expect(calls).toEqual([["a\nb", "typescript", THEME]]);
});

test("reports no highlighting for unknown languages and highlighter failures", async () => {
  const highlight = await loadHighlighter({
    getLanguageFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : undefined),
    highlightCode: () => {
      throw new Error("tokenizer unavailable");
    },
  });

  expect(highlight?.("a", "notes.unknown", THEME)).toBeUndefined();
  expect(highlight?.("a", "app.ts", THEME)).toBeUndefined();
});

test("ignores a host that does not expose the highlighting exports", async () => {
  let consulted = false;
  const highlight = await loadHighlighter({
    getLanguageFromPath: () => {
      consulted = true;
      return "typescript";
    },
  });

  // A partial host falls back to the plugin-local import instead of calling
  // into an incomplete namespace.
  highlight?.("a", "app.ts", THEME);
  expect(consulted).toBe(false);
});
