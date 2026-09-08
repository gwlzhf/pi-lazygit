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
import { FilesPanel, type FilesPanelOptions } from "./ui/files-panel";

export interface ExtensionDependencies {
  readonly createReviewSource: (cwd: string) => ReviewSource;
  readonly prepareSession: (cwd: string) => Promise<void>;
  readonly clearSession: () => void;
  readonly createPanel: (options: FilesPanelOptions) => FilesPanel;
}

export const FILES_SHORTCUT = "alt+q";

const productionDependencies: ExtensionDependencies = {
  createReviewSource,
  prepareSession: prepareSessionBaseline,
  clearSession: clearSessionBaselines,
  createPanel: options => new FilesPanel(options),
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
        await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
          const panel = dependencies.createPanel({
            cwd: ctx.cwd,
            source,
            tui,
            theme,
            keybindings,
            ...(sessionName === undefined ? {} : { sessionName }),
            done,
          });
          panel.start();
          return panel;
        });
      } catch (error) {
        ctx.ui.notify(
          `Unable to open files review: ${errorMessage(error)}`,
          "error",
        );
      } finally {
        panelOpen = false;
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
