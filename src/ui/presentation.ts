import type { FileLineSummary } from "../contracts";

export interface PanelAction {
  readonly key: string;
  readonly label: string;
}

export interface PanelPresentationInput {
  readonly sourceKind: "git" | "filesystem" | undefined;
  readonly leftMode: "files" | "log" | "branches";
  readonly focus: "tree" | "preview";
  readonly viewMode: "modified" | "all";
  readonly scope: "workspace" | "session";
  readonly currentBranch?: string;
  readonly detachedAt?: string;
  readonly fileCount: number;
  readonly selectedPath?: string;
  readonly selectedSummary?: FileLineSummary;
  readonly status?: string;
}

export interface PanelPresentation {
  readonly overviewTitle: string;
  readonly overviewMeta: string;
  readonly leftTitle: string;
  readonly rightTitle: string;
  readonly status?: string;
  readonly actions: readonly PanelAction[];
}

function overviewTitle(input: PanelPresentationInput): string {
  if (input.leftMode === "branches") return "Switch branch";
  if (input.leftMode === "log") return "History";
  if (input.sourceKind === "filesystem") return "Project files";
  return input.scope === "session" ? "Diff session" : "Diff working tree";
}

function overviewMeta(input: PanelPresentationInput): string {
  const files = `${input.fileCount} ${input.fileCount === 1 ? "file" : "files"}`;
  if (input.currentBranch !== undefined) return `${input.currentBranch} · ${files}`;
  if (input.detachedAt !== undefined) return `detached ${input.detachedAt} · ${files}`;
  return files;
}

function leftTitle(input: PanelPresentationInput): string {
  if (input.leftMode === "branches") return "Branches";
  if (input.leftMode === "log") return "History";
  return "Files";
}

function rightTitle(input: PanelPresentationInput): string {
  if (input.leftMode === "branches") return "Preview";
  if (input.selectedPath === undefined) return "Preview";
  if (input.selectedSummary === undefined) return input.selectedPath;
  return `${input.selectedPath} · +${input.selectedSummary.insertions} -${input.selectedSummary.deletions}`;
}

function actionsFor(input: PanelPresentationInput): readonly PanelAction[] {
  if (input.leftMode === "branches") {
    return [
      { key: "n", label: "next" },
      { key: "p", label: "previous" },
      { key: "enter", label: "switch" },
      { key: "b", label: "files" },
      { key: "?", label: "all" },
    ];
  }
  if (input.leftMode === "log") {
    return [
      { key: "tab", label: "focus preview" },
      { key: "n", label: "next" },
      { key: "p", label: "previous" },
      { key: "enter", label: "open" },
      { key: "g", label: "files" },
      { key: "b", label: "branches" },
      { key: "?", label: "all" },
    ];
  }
  const actions: PanelAction[] = [
    { key: "tab", label: "focus preview" },
    { key: "n", label: "next" },
    { key: "p", label: "previous" },
    { key: "enter", label: "open" },
  ];
  if (input.sourceKind !== "filesystem") {
    actions.push({ key: "b", label: "branches" }, { key: "g", label: "history" });
  }
  actions.push({ key: "?", label: "all" });
  return actions;
}

export function panelPresentation(input: PanelPresentationInput): PanelPresentation {
  return {
    overviewTitle: overviewTitle(input),
    overviewMeta: overviewMeta(input),
    leftTitle: leftTitle(input),
    rightTitle: rightTitle(input),
    ...(input.status !== undefined ? { status: input.status } : {}),
    actions: actionsFor(input),
  };
}

export const PANEL_HELP_GROUPS: readonly {
  readonly title: string;
  readonly actions: readonly PanelAction[];
}[] = [
  {
    title: "Navigation",
    actions: [
      { key: "tab", label: "focus preview" },
      { key: "n", label: "next" },
      { key: "p", label: "previous" },
      { key: "↑/↓", label: "move" },
      { key: "enter", label: "open" },
    ],
  },
  {
    title: "Review",
    actions: [
      { key: "b", label: "branches" },
      { key: "g", label: "history" },
      { key: "m/a", label: "modified/all" },
      { key: "s", label: "scope" },
      { key: "r", label: "refresh" },
    ],
  },
  {
    title: "Layout",
    actions: [
      { key: "d", label: "layout" },
      { key: "c", label: "context" },
      { key: "t", label: "theme" },
      { key: "[", label: "narrower" },
      { key: "]", label: "wider" },
      { key: "\\", label: "toggle tree" },
    ],
  },
  {
    title: "Mouse",
    actions: [
      { key: "click", label: "select" },
      { key: "drag", label: "copy" },
      { key: "j/k", label: "scroll" },
      { key: "?", label: "all" },
      { key: "esc", label: "close" },
    ],
  },
];
