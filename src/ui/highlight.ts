/**
 * Syntax highlighting for text previews.
 *
 * The panel takes a {@link Highlighter} as an option instead of importing one:
 * OMP's highlighter lives behind the coding-agent entry point (a native
 * tokenizer plus its whole module graph), which the panel's unit tests must not
 * load. `loadHighlighter` resolves it lazily at panel-open time and reports
 * `undefined` when it is unavailable, in which case previews render unstyled.
 */

import type { Theme } from "@oh-my-pi/pi-coding-agent";

export const HIGHLIGHT_THEMES = [
  { name: "pi", label: "Pi", ompName: undefined },
  { name: "catppuccin", label: "Catppuccin", ompName: "dark-catppuccin" },
  { name: "nord", label: "Nord", ompName: "dark-nord" },
  { name: "tokyo-night", label: "Tokyo Night", ompName: "dark-tokyo-night" },
] as const;

export type HighlightThemeName = (typeof HIGHLIGHT_THEMES)[number]["name"];

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

/** The slice of OMP's coding-agent exports the highlighter needs. */
export interface HighlightModule {
  readonly getLanguageFromPath: (path: string) => string | undefined;
  readonly getThemeByName: (name: string) => Promise<Theme | undefined>;
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
    && typeof candidate.getThemeByName === "function"
    && typeof candidate.highlightCode === "function"
  );
}

/**
 * Resolve OMP's tokenizer and the three optional palettes once when the panel
 * opens. Pi uses the active host theme passed at highlight time. Prefer the
 * host namespace; fall back to the plugin-local dependency when the host does
 * not expose the complete API.
 */
export async function loadHighlighter(host?: unknown): Promise<Highlighter | undefined> {
  const module = await resolveModule(host);
  if (module === undefined) return undefined;

  try {
    const [loaded] = await Promise.all([
      Promise.all(
        HIGHLIGHT_THEMES
          .filter(theme => theme.ompName !== undefined)
          .map(async ({ name, ompName }) => {
            if (ompName === undefined) return undefined;
            const theme = await module.getThemeByName(ompName);
            return theme === undefined ? undefined : ([name, theme] as const);
          }),
      ),
      module.warmHighlighter?.().catch(() => undefined),
    ]);
    if (loaded.some(entry => entry === undefined)) return undefined;
    const themes = Object.fromEntries(
      loaded as ReadonlyArray<readonly [HighlightThemeName, Theme]>,
    ) as Partial<Record<HighlightThemeName, Theme>>;
    const highlight: Highlighter = (code, path, themeName, piTheme) => {
      const language = module.getLanguageFromPath(path);
      if (language === undefined) return undefined;
      const theme = themeName === "pi" ? piTheme : themes[themeName];
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
        const theme = themeName === "pi" ? piTheme : themes[themeName];
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
    const imported = await import("@oh-my-pi/pi-coding-agent");
    return isHighlightModule(imported) ? imported : undefined;
  } catch {
    return undefined;
  }
}
