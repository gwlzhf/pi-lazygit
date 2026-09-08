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

/**
 * Highlight `code` for the language implied by `path`, returning one entry per
 * input line, or `undefined` when the language is unknown or unsupported.
 * Input is already sanitized; the returned lines carry only color escapes.
 *
 * `theme` is passed on to OMP's highlighter: it reads the syntax colors off the
 * theme instance rather than off a module-level singleton, which is only set in
 * the host's own copy of the coding-agent module.
 */
export type Highlighter = (code: string, path: string, theme: Theme) => readonly string[] | undefined;

/** The slice of OMP's coding-agent exports the highlighter needs. */
export interface HighlightModule {
  readonly getLanguageFromPath: (path: string) => string | undefined;
  readonly highlightCode: (code: string, language?: string, theme?: Theme) => string[];
}

function isHighlightModule(value: unknown): value is HighlightModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HighlightModule>;
  return typeof candidate.getLanguageFromPath === "function" && typeof candidate.highlightCode === "function";
}

/**
 * Resolve the highlighter, preferring `host` — the coding-agent namespace OMP
 * injects into extensions as `pi.pi`. A dynamic `import` resolves to the copy
 * in this plugin's own `node_modules`, a separate module instance whose theme
 * singleton is never initialized, so its highlighter silently returns plain
 * text. The import stays as a fallback for hosts that inject nothing.
 */
export async function loadHighlighter(host?: unknown): Promise<Highlighter | undefined> {
  const module = await resolveModule(host);
  if (module === undefined) return undefined;
  return (code, path, theme) => {
    const language = module.getLanguageFromPath(path);
    if (language === undefined) return undefined;
    try {
      return module.highlightCode(code, language, theme);
    } catch {
      return undefined;
    }
  };
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
