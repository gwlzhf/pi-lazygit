/**
 * Syntax highlighting for text previews.
 *
 * The panel takes a {@link Highlighter} as an option instead of importing one:
 * OMP's highlighter lives behind the coding-agent entry point (a native
 * tokenizer plus its whole module graph), which the panel's unit tests must not
 * load. `loadHighlighter` resolves it lazily at panel-open time and reports
 * `undefined` when it is unavailable, in which case previews render unstyled.
 */

/**
 * Highlight `code` for the language implied by `path`, returning one entry per
 * input line, or `undefined` when the language is unknown or unsupported.
 * Input is already sanitized; the returned lines carry only color escapes.
 */
export type Highlighter = (code: string, path: string) => readonly string[] | undefined;

export async function loadHighlighter(): Promise<Highlighter | undefined> {
  try {
    const { getLanguageFromPath, highlightCode } = await import("@oh-my-pi/pi-coding-agent");
    return (code, path) => {
      const language = getLanguageFromPath(path);
      if (language === undefined) return undefined;
      try {
        return highlightCode(code, language);
      } catch {
        return undefined;
      }
    };
  } catch {
    return undefined;
  }
}
