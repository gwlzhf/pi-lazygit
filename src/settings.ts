import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { DEFAULT_TREE_RATIO, TREE_MAX_RATIO, TREE_MIN_RATIO } from "./contracts";

/** Panel preferences that outlive a single OMP session. */
export interface PanelSettings {
  readonly treeRatio: number;
}

/** Storage for {@link PanelSettings}; writes coalesce so a drag is one file write. */
export interface PanelSettingsStore {
  load(): Promise<PanelSettings>;
  saveTreeRatio(ratio: number): void;
  flush(): Promise<void>;
}

const SETTINGS_FILE = "pi-lazygit.json";
const WRITE_DELAY_MS = 400;

export const DEFAULT_PANEL_SETTINGS: PanelSettings = { treeRatio: DEFAULT_TREE_RATIO };

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
  let pending: number | undefined;
  let pendingWrite: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = async (ratio: number): Promise<void> => {
    try {
      const file = await resolvePath();
      await mkdir(nodePath.dirname(file), { recursive: true });
      const value: PanelSettings = { treeRatio: ratio };
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
    const ratio = pending;
    pending = undefined;
    if (ratio === undefined) return pendingWrite ?? Promise.resolve();
    pendingWrite = write(ratio);
    return pendingWrite;
  };

  return {
    async load(): Promise<PanelSettings> {
      try {
        const parsed: unknown = JSON.parse(await readFile(await resolvePath(), "utf8"));
        if (typeof parsed !== "object" || parsed === null) return DEFAULT_PANEL_SETTINGS;
        const treeRatio = clampTreeRatio((parsed as { treeRatio?: unknown }).treeRatio);
        return treeRatio === undefined ? DEFAULT_PANEL_SETTINGS : { treeRatio };
      } catch {
        return DEFAULT_PANEL_SETTINGS;
      }
    },

    saveTreeRatio(ratio: number): void {
      const clamped = clampTreeRatio(ratio);
      if (clamped === undefined) return;
      pending = clamped;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void writeNow();
      }, WRITE_DELAY_MS);
      timer.unref?.();
    },

    async flush(): Promise<void> {
      await writeNow();
      await pendingWrite;
    },
  };
}
