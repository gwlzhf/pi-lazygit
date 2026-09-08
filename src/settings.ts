import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  DEFAULT_DIFF_CONTEXT,
  DEFAULT_DIFF_LAYOUT,
  DEFAULT_TREE_RATIO,
  isDiffLayout,
  normalizeDiffContext,
  TREE_MAX_RATIO,
  TREE_MIN_RATIO,
  type DiffLayout,
} from "./contracts";
import {
  DEFAULT_HIGHLIGHT_THEME,
  isHighlightThemeName,
  type HighlightThemeName,
} from "./ui/highlight";

/** Panel preferences that outlive a single OMP session. */
export interface PanelSettings {
  readonly treeRatio: number;
  readonly treeCollapsed: boolean;
  readonly highlightTheme: HighlightThemeName;
  readonly diffLayout: DiffLayout;
  readonly diffContext: number;
}

/** Storage for {@link PanelSettings}; writes coalesce so a drag is one file write. */
export interface PanelSettingsStore {
  load(): Promise<PanelSettings>;
  saveTreeRatio(ratio: number): void;
  saveTreeCollapsed(collapsed: boolean): void;
  saveHighlightTheme(theme: HighlightThemeName): void;
  saveDiffLayout(layout: DiffLayout): void;
  saveDiffContext(context: number): void;
  flush(): Promise<void>;
}

const SETTINGS_FILE = "pi-lazygit.json";
const WRITE_DELAY_MS = 400;

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  treeRatio: DEFAULT_TREE_RATIO,
  treeCollapsed: false,
  highlightTheme: DEFAULT_HIGHLIGHT_THEME,
  diffLayout: DEFAULT_DIFF_LAYOUT,
  diffContext: DEFAULT_DIFF_CONTEXT,
};

/** Clamp a stored or reported ratio into the supported range, or reject it. */
export function clampTreeRatio(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(TREE_MIN_RATIO, Math.min(TREE_MAX_RATIO, value));
}

async function settingsPath(): Promise<string> {
  // Imported lazily: the OMP entry point is a heavy module graph and only the
  // persistence path needs it.
  const { getAgentDir } = await import("@oh-my-pi/pi-coding-agent");
  return nodePath.join(getAgentDir(), SETTINGS_FILE);
}

/**
 * Panel settings persisted as JSON under the OMP agent directory. Every read
 * and write failure degrades to the defaults: the panel is a review tool and
 * must open even when its preferences file is missing or corrupt.
 */
export function createPanelSettingsStore(
  resolvePath: () => Promise<string> = settingsPath,
): PanelSettingsStore {
  let current: PanelSettings = DEFAULT_PANEL_SETTINGS;
  let dirty = false;
  let writeChain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = async (value: PanelSettings): Promise<void> => {
    try {
      const file = await resolvePath();
      await mkdir(nodePath.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    } catch {
      // Preferences are best-effort; a read-only or unwritable config dir is
      // not worth interrupting a review session for.
    }
  };

  const writeNow = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) return writeChain;

    const value = current;
    dirty = false;
    writeChain = writeChain.then(() => write(value));
    return writeChain;
  };

  const scheduleWrite = (): void => {
    dirty = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void writeNow();
    }, WRITE_DELAY_MS);
    timer.unref?.();
  };

  return {
    async load(): Promise<PanelSettings> {
      try {
        const parsed: unknown = JSON.parse(await readFile(await resolvePath(), "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
          current = DEFAULT_PANEL_SETTINGS;
          return current;
        }
        const value = parsed as {
          treeRatio?: unknown;
          treeCollapsed?: unknown;
          highlightTheme?: unknown;
          diffLayout?: unknown;
          diffContext?: unknown;
        };
        current = {
          treeRatio: clampTreeRatio(value.treeRatio) ?? DEFAULT_PANEL_SETTINGS.treeRatio,
          treeCollapsed: typeof value.treeCollapsed === "boolean"
            ? value.treeCollapsed
            : DEFAULT_PANEL_SETTINGS.treeCollapsed,
          highlightTheme: isHighlightThemeName(value.highlightTheme)
            ? value.highlightTheme
            : DEFAULT_PANEL_SETTINGS.highlightTheme,
          diffLayout: isDiffLayout(value.diffLayout)
            ? value.diffLayout
            : DEFAULT_PANEL_SETTINGS.diffLayout,
          diffContext: normalizeDiffContext(value.diffContext) ?? DEFAULT_PANEL_SETTINGS.diffContext,
        };
        return current;
      } catch {
        current = DEFAULT_PANEL_SETTINGS;
        return current;
      }
    },

    saveTreeRatio(ratio: number): void {
      const clamped = clampTreeRatio(ratio);
      if (clamped === undefined) return;
      current = { ...current, treeRatio: clamped };
      scheduleWrite();
    },

    saveTreeCollapsed(collapsed: boolean): void {
      if (typeof collapsed !== "boolean") return;
      current = { ...current, treeCollapsed: collapsed };
      scheduleWrite();
    },

    saveHighlightTheme(theme: HighlightThemeName): void {
      if (!isHighlightThemeName(theme)) return;
      current = { ...current, highlightTheme: theme };
      scheduleWrite();
    },

    saveDiffLayout(layout: DiffLayout): void {
      if (!isDiffLayout(layout)) return;
      current = { ...current, diffLayout: layout };
      scheduleWrite();
    },

    saveDiffContext(context: number): void {
      const normalized = normalizeDiffContext(context);
      if (normalized === undefined) return;
      current = { ...current, diffContext: normalized };
      scheduleWrite();
    },

    async flush(): Promise<void> {
      do {
        await writeNow();
      } while (dirty);
    },
  };
}
