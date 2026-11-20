import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ReviewSource } from "./contracts";
import {
  clearProjectBaselineCache,
  clearSessionBaselines,
  createReviewSource,
  prepareSessionBaseline,
  setSessionBaselineCacheEnabled,
} from "./review-source";
import { createPanelSettingsStore, type PanelSettingsStore } from "./settings";
import { FilesPanel, type FilesPanelOptions } from "./ui/files-panel";
import { loadHighlighter, type Highlighter } from "./ui/highlight";

export interface ExtensionDependencies {
  readonly createReviewSource: (cwd: string, cacheEnabled?: boolean) => ReviewSource;
  readonly prepareSession: (cwd: string, cacheEnabled?: boolean) => Promise<void>;
  readonly setCacheEnabled: (enabled: boolean) => void;
  readonly clearSession: (cacheEnabled?: boolean) => void | Promise<void>;
  readonly clearCache: (cwd: string) => Promise<void>;
  readonly createPanel: (options: FilesPanelOptions) => FilesPanel;
  readonly settings: PanelSettingsStore;
  readonly loadHighlighter: (host?: unknown) => Promise<Highlighter | undefined>;
}

export const FILES_SHORTCUT = "alt+d";

const productionDependencies: ExtensionDependencies = {
  createReviewSource: (cwd, cacheEnabled) => createReviewSource(cwd, cacheEnabled ?? true),
  prepareSession: (cwd, cacheEnabled) => prepareSessionBaseline(cwd, cacheEnabled ?? true),
  setCacheEnabled: setSessionBaselineCacheEnabled,
  clearSession: clearSessionBaselines,
  clearCache: clearProjectBaselineCache,
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
    let highlighterPromise: Promise<Highlighter | undefined> | undefined;
    const loadHighlighterOnce = (): Promise<Highlighter | undefined> => {
      highlighterPromise ??= Promise.resolve()
        .then(() => dependencies.loadHighlighter())
        .catch(() => undefined);
      return highlighterPromise;
    };
    const openFileReview = async (ctx: ExtensionContext): Promise<void> => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify(
          "Files review is available only in Pi's interactive TUI.",
          "warning",
        );
        return;
      }

      if (panelOpen) {
        return;
      }

      panelOpen = true;
      try {
        const sessionName = pi.getSessionName();
        const settings = await dependencies.settings.load();
        const source = dependencies.createReviewSource(ctx.cwd, settings.cacheEnabled);
        await ctx.ui.custom<undefined>(
          (tui, theme, keybindings, done) => {
            const panel = dependencies.createPanel({
              cwd: ctx.cwd,
              source,
              tui,
              theme,
              ...(sessionName === undefined ? {} : { sessionName }),
              treeRatio: settings.treeRatio,
              treeCollapsed: settings.treeCollapsed,
              highlightTheme: settings.highlightTheme,
              diffLayout: settings.diffLayout,
              diffContext: settings.diffContext,
              diffMaskOpacity: settings.diffMaskOpacity,
              commitTimeoutMs: settings.commitTimeoutMs,
              pushTimeoutMs: settings.pushTimeoutMs,
              protectedBranches: settings.protectedBranches,
              onTreeRatioChange: ratio => {
                dependencies.settings.saveTreeRatio(ratio);
              },
              onTreeCollapsedChange: collapsed => {
                dependencies.settings.saveTreeCollapsed(collapsed);
              },
              onHighlightThemeChange: highlightTheme => {
                dependencies.settings.saveHighlightTheme(highlightTheme);
              },
              onDiffLayoutChange: diffLayout => {
                dependencies.settings.saveDiffLayout(diffLayout);
              },
              onDiffContextChange: diffContext => {
                dependencies.settings.saveDiffContext(diffContext);
              },
              onDiffMaskOpacityChange: opacity => {
                dependencies.settings.saveDiffMaskOpacity(opacity);
              },
              done,
            });
            panel.start();
            // Show the panel first; Pi's highlighter module graph is expensive to
            // load and is not needed to render the initial loading state.
            setTimeout(() => {
              void loadHighlighterOnce().then(highlight => {
                if (highlight !== undefined) panel.setHighlighter(highlight);
              });
            }, 0);
            return panel;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "top-left",
              width: "100%",
              maxHeight: "100%",
              margin: 0,
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
        await dependencies.settings.flush();
      }
    };

    pi.registerCommand("files", {
      description: "Review project files and changes",
      handler: async (_args, ctx) => {
        await openFileReview(ctx);
      },
    });
    pi.registerCommand("files-cache", {
      description: "Enable or disable persistent session baseline caching",
      handler: async (args, ctx) => {
        const setting = args.trim().toLowerCase();
        if (setting !== "on" && setting !== "off") {
          ctx.ui.notify("Usage: /files-cache on|off", "warning");
          return;
        }
        await dependencies.settings.load();
        const enabled = setting === "on";
        dependencies.settings.saveCacheEnabled(enabled);
        await dependencies.settings.flush();
        dependencies.setCacheEnabled(enabled);
        if (!enabled) await dependencies.clearCache(ctx.cwd);
        ctx.ui.notify(`Persistent baseline cache ${enabled ? "enabled" : "disabled"}.`);
      },
    });

    pi.registerCommand("clear-cache", {
      description: "Clear the persistent session baseline cache for this project",
      handler: async (_args, ctx) => {
        try {
          await dependencies.clearCache(ctx.cwd);
          ctx.ui.notify("Persistent session baseline cache cleared.");
        } catch (error) {
          ctx.ui.notify(`Unable to clear session baseline cache: ${errorMessage(error)}`, "warning");
        }
      },
    });


    pi.registerShortcut(FILES_SHORTCUT, {
      description: "Review project files and changes",
      handler: openFileReview,
    });

    // Pi awaits session_start before the UI becomes interactive, so the baseline
    // is captured in the background. Opening the panel joins the in-flight capture.
    pi.on("session_start", (_event, ctx) => {
      void (async () => {
        try {
          const settings = await dependencies.settings.load();
          dependencies.setCacheEnabled(settings.cacheEnabled);
          await dependencies.prepareSession(ctx.cwd, settings.cacheEnabled);
        } catch (error) {
          ctx.ui.notify(
            `Unable to prepare the files review session baseline: ${errorMessage(error)}`,
            "warning",
          );
        }
      })();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const settings = await dependencies.settings.load();
      dependencies.setCacheEnabled(settings.cacheEnabled);
      await dependencies.clearSession(settings.cacheEnabled);
    });
  };
}

export default function extension(pi: ExtensionAPI): void {
  createExtension()(pi);
}
