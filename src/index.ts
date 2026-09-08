import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { ReviewSource } from "./contracts";
import {
  clearSessionBaselines,
  createReviewSource,
  prepareSessionBaseline,
} from "./review-source";
import { createPanelSettingsStore, type PanelSettingsStore } from "./settings";
import { FilesPanel, type FilesPanelOptions } from "./ui/files-panel";
import { loadHighlighter, type Highlighter } from "./ui/highlight";

export interface ExtensionDependencies {
  readonly createReviewSource: (cwd: string) => ReviewSource;
  readonly prepareSession: (cwd: string) => Promise<void>;
  readonly clearSession: () => void;
  readonly createPanel: (options: FilesPanelOptions) => FilesPanel;
  readonly settings: PanelSettingsStore;
  readonly loadHighlighter: (host?: unknown) => Promise<Highlighter | undefined>;
}

export const FILES_SHORTCUT = "alt+q";

const productionDependencies: ExtensionDependencies = {
  createReviewSource,
  prepareSession: prepareSessionBaseline,
  clearSession: clearSessionBaselines,
  createPanel: options => new FilesPanel(options),
  settings: createPanelSettingsStore(),
  loadHighlighter,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createExtension(
  dependencies: ExtensionDependencies = productionDependencies,
): (pi: ExtensionAPI) => void {
  return pi => {
    let panelOpen = false;

    const openFileReview = async (ctx: ExtensionContext): Promise<void> => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify(
          "Files review is available only in OMP's interactive TUI.",
          "warning",
        );
        return;
      }

      if (panelOpen) {
        return;
      }

      panelOpen = true;
      try {
        const source = dependencies.createReviewSource(ctx.cwd);
        const sessionName = pi.getSessionName();
        const [settings, highlight] = await Promise.all([
          dependencies.settings.load(),
          // `pi.pi` is the host's own coding-agent namespace; its theme
          // singleton is initialized, unlike the copy a plugin-local import
          // would resolve to.
          dependencies.loadHighlighter(pi.pi),
        ]);
        await ctx.ui.custom<undefined>(
          (tui, theme, keybindings, done) => {
            const panel = dependencies.createPanel({
              cwd: ctx.cwd,
              source,
              tui,
              theme,
              keybindings,
              ...(sessionName === undefined ? {} : { sessionName }),
              treeRatio: settings.treeRatio,
              highlightTheme: settings.highlightTheme,
              onTreeRatioChange: ratio => {
                dependencies.settings.saveTreeRatio(ratio);
              },
              onHighlightThemeChange: highlightTheme => {
                dependencies.settings.saveHighlightTheme(highlightTheme);
              },
              ...(highlight === undefined ? {} : { highlight }),
              done,
            });
            panel.start();
            return panel;
          },
          // A fullscreen overlay paints from screen row 0 and is the only OMP
          // surface that turns on terminal mouse reporting, which the panel
          // needs for wheel scrolling and divider drag-resize.
          {
            overlay: true,
            overlayOptions: {
              anchor: "top-left",
              width: "100%",
              maxHeight: "100%",
              margin: 0,
              fullscreen: true,
              mouseTracking: true,
            },
          },
        );
      } catch (error) {
        ctx.ui.notify(
          `Unable to open files review: ${errorMessage(error)}`,
          "error",
        );
      } finally {
        panelOpen = false;
        // The panel coalesces width changes; make sure the last one reaches
        // disk even if the session ends right after the panel closes.
        await dependencies.settings.flush();
      }
    };

    pi.registerCommand("files", {
      description: "Review project files and changes",
      handler: async (_args, ctx) => {
        await openFileReview(ctx);
      },
    });

    pi.registerShortcut(FILES_SHORTCUT, {
      description: "Review project files and changes",
      handler: openFileReview,
    });

    pi.on("session_start", async (_event, ctx) => {
      try {
        await dependencies.prepareSession(ctx.cwd);
      } catch (error) {
        ctx.ui.notify(
          `Unable to prepare the files review session baseline: ${errorMessage(error)}`,
          "warning",
        );
      }
    });

    pi.on("session_shutdown", () => {
      dependencies.clearSession();
    });
  };
}

export default function extension(pi: ExtensionAPI): void {
  createExtension()(pi);
}
