/**
 * Syntax highlighting for text previews.
 *
 * The panel takes a {@link Highlighter} as an option instead of importing one.
 * `loadHighlighter` lazily resolves Pi's theme module after the panel opens, so
 * the panel's unit tests never load the SDK module. It reports `undefined` when
 * highlighting is unavailable, in which case previews render unstyled.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export const HIGHLIGHT_THEMES = [
  { name: "pi", label: "Pi", piName: undefined },
  { name: "catppuccin", label: "Catppuccin", piName: "dark-catppuccin" },
  { name: "nord", label: "Nord", piName: "dark-nord" },
  { name: "tokyo-night", label: "Tokyo Night", piName: "dark-tokyo-night" },
] as const;

export type HighlightThemeName = (typeof HIGHLIGHT_THEMES)[number]["name"];
type OptionalHighlightThemeName = Exclude<HighlightThemeName, "pi">;

export const DEFAULT_HIGHLIGHT_THEME: HighlightThemeName = "pi";

export function getHighlightThemeLabel(name: HighlightThemeName): string {
  return HIGHLIGHT_THEMES.find(theme => theme.name === name)?.label ?? name;
}

export function isHighlightThemeName(value: unknown): value is HighlightThemeName {
  return HIGHLIGHT_THEMES.some(theme => theme.name === value);
}

/**
 * Highlight `code` for the language implied by `path`, returning one entry per
 * input line, or `undefined` when the language is unknown or unsupported.
 */
export interface HighlighterStream {
  push(chunk: string): string;
}

export interface Highlighter {
  (
    code: string,
    path: string,
    themeName: HighlightThemeName,
    piTheme: Theme,
  ): readonly string[] | undefined;
  readonly createStream?: (
    path: string,
    themeName: HighlightThemeName,
    piTheme: Theme,
  ) => HighlighterStream | undefined;
}

/** The slice of Pi's coding-agent exports the highlighter needs. */
export interface HighlightModule {
  readonly getLanguageFromPath: (path: string) => string | undefined;
  readonly getThemeByName?: (name: string) => Promise<Theme | undefined>;
  readonly highlightCode: (code: string, language?: string, theme?: Theme) => string[];
  readonly createHighlightStream?: (
    language: string | undefined,
    theme?: Theme,
  ) => HighlighterStream | null;
  readonly warmHighlighter?: () => Promise<void>;
}

function isHighlightModule(value: unknown): value is HighlightModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HighlightModule>;
  return (
    typeof candidate.getLanguageFromPath === "function"
    && typeof candidate.highlightCode === "function"
  );
}

/**
 * Resolve Pi's tokenizer and the three optional palettes once when the panel
 * opens. Pi uses the active host theme passed at highlight time. Prefer the
 * host namespace; fall back to the plugin-local dependency when the host does
 * not expose the complete API.
 */
export async function loadHighlighter(host?: unknown): Promise<Highlighter | undefined> {
  const module = await resolveModule(host);
  if (module === undefined) return undefined;

  try {
    const loadThemes = async (): Promise<Array<readonly [OptionalHighlightThemeName, Theme]>> => {
      if (module.getThemeByName === undefined) return [];
      const themes = await Promise.all(
        HIGHLIGHT_THEMES
          .filter(theme => theme.piName !== undefined)
          .map(async ({ name, piName }) => {
            if (piName === undefined) return undefined;
            try {
              const theme = await module.getThemeByName?.(piName);
              return theme === undefined ? undefined : ([name, theme] as const);
            } catch {
              return undefined;
            }
          }),
      );
      return themes.filter((theme): theme is readonly [OptionalHighlightThemeName, Theme] => (
        theme !== undefined
      ));
    };
    const [loaded] = await Promise.all([
      loadThemes(),
      module.warmHighlighter?.().catch(() => undefined),
    ]);
    const themes = Object.fromEntries(loaded) as Partial<Record<HighlightThemeName, Theme>>;
    const highlight: Highlighter = (code, path, themeName, piTheme) => {
      const language = module.getLanguageFromPath(path);
      if (language === undefined) return undefined;
      const theme = themeName === "pi" ? piTheme : themes[themeName] ?? piTheme;
      if (theme === undefined) return undefined;
      try {
        return module.highlightCode(code, language, theme);
      } catch {
        return undefined;
      }
    };
    if (module.createHighlightStream === undefined) return highlight;
    return Object.assign(highlight, {
      createStream(
        path: string,
        themeName: HighlightThemeName,
        piTheme: Theme,
      ): HighlighterStream | undefined {
        const language = module.getLanguageFromPath(path);
        if (language === undefined) return undefined;
        const theme = themeName === "pi" ? piTheme : themes[themeName] ?? piTheme;
        if (theme === undefined) return undefined;
        try {
          return module.createHighlightStream?.(language, theme) ?? undefined;
        } catch {
          return undefined;
        }
      },
    });
  } catch {
    return undefined;
  }
}

async function resolveModule(host: unknown): Promise<HighlightModule | undefined> {
  if (isHighlightModule(host)) return host;
  try {
    // Pi 1.0.4's root entry imports the full CLI graph. The theme module is the
    // same implementation but avoids several seconds of unrelated startup work.
    const entrypoint = import.meta.resolve("@earendil-works/pi-coding-agent");
    const themeModule = await import(
      new URL("./modes/interactive/theme/theme.js", entrypoint).href
    );
    if (isHighlightModule(themeModule)) return themeModule;
  } catch {
    // Keep compatibility with hosts that expose only the package root.
  }
  try {
    const imported = await import("@earendil-works/pi-coding-agent");
    return isHighlightModule(imported) ? imported : undefined;
  } catch {
    return undefined;
  }
}
