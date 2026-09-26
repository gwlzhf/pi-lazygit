import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { Editor, type Component, type TUI } from "@oh-my-pi/pi-tui";
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


/** The fullscreen overlay owns focus, but the core composer remains mounted. */
function hostEditor(tui: TUI): Editor | undefined {
  const focused = tui.getFocused();
  return focused instanceof Editor ? focused : undefined;
}

/** Reuse the native /btw response while the fullscreen review hides the transcript. */
function btwResponse(tui: TUI, width: number): readonly string[] {
  // OMP mounts /btw below a root container even while its fullscreen overlay
  // hides the root. Search only that level; never traverse the transcript.
  for (const root of tui.children) {
    for (const child of (root as Component & { children?: Component[] }).children ?? []) {
      const panel = child as Component & {
        isCopyable?: () => boolean;
        getCopyText?: () => string | undefined;
        children?: Component[];
      };
      if (typeof panel.isCopyable !== "function" || typeof panel.getCopyText !== "function") continue;
      return panel.children?.[1]?.render(width) ?? [];
    }
  }
  return [];
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
            const editor = hostEditor(tui);
            if (editor === undefined) throw new Error("The OMP editor is not available for embedded chat.");
            const panel = dependencies.createPanel({
              cwd: ctx.cwd,
              source,
              tui,
              theme,
              keybindings,
              ...(sessionName === undefined ? {} : { sessionName }),
              treeRatio: settings.treeRatio,
              treeCollapsed: settings.treeCollapsed,
              highlightTheme: settings.highlightTheme,
              diffLayout: settings.diffLayout,
              diffContext: settings.diffContext,
              diffMaskOpacity: settings.diffMaskOpacity,
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
              onChat: excerpt => {
                const draft = ctx.ui.getEditorText();
                const question = /^\/btw(?:\s|$)/u.test(draft) ? draft : `/btw ${draft}`;
                const selected = excerpt === undefined
                  ? ""
                  : `\n\nReview diff excerpt:\n${excerpt.split("\n").map(line => `    ${line}`).join("\n")}`;
                ctx.ui.setEditorText(`${question.trimEnd()} ${selected}`);
                editor.moveToMessageStart();
                editor.moveToLineEnd();
              },
              chatEditor: editor,
              chatResponse: width => btwResponse(tui, width),
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
