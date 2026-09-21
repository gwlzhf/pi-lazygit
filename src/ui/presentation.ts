import type { ChangeScope, FileLineSummary, ViewMode } from "../contracts";

export interface PanelAction {
  readonly key: string;
  readonly label: string;
}

export interface PanelPresentationInput {
  readonly sourceKind: "git" | "filesystem" | undefined;
  readonly leftMode: "files" | "log" | "branches";
  readonly focus: "tree" | "preview";
  readonly viewMode: ViewMode;
  readonly scope: ChangeScope;
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
  const branch = input.currentBranch !== undefined
    ? input.currentBranch
    : input.detachedAt !== undefined
      ? `detached ${input.detachedAt}`
      : undefined;
  const files = `${input.fileCount} files`;
  return branch === undefined ? files : `${branch} · ${files}`;
}

function leftTitle(input: PanelPresentationInput): string {
  if (input.leftMode === "branches") return "Branches";
  if (input.leftMode === "log") return "History";
  return "Files";
}

function rightTitle(input: PanelPresentationInput): string {
  if (input.focus === "preview" && input.leftMode !== "log" && input.leftMode !== "branches" && input.selectedPath === undefined) {
    return "Preview";
  }
  if (input.selectedPath === undefined) return "Preview";
  const summary = input.selectedSummary;
  return summary === undefined
    ? input.selectedPath
    : `${input.selectedPath} · +${summary.insertions} -${summary.deletions}`;
}

function actionsFor(input: PanelPresentationInput): PanelAction[] {
  if (input.focus === "preview") {
    return [
      { key: "tab", label: "focus tree" },
      { key: "j/k", label: "scroll" },
      { key: "d", label: "layout" },
      { key: "c", label: "context" },
      { key: "b", label: "branches" },
      { key: "?", label: "all" },
    ];
  }
  if (input.leftMode === "branches") {
    return [
      { key: "tab", label: "focus preview" },
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
      { key: "b", label: "branches" },
      { key: "g", label: "files" },
      { key: "?", label: "all" },
    ];
  }
  return [
    { key: "tab", label: "focus preview" },
    { key: "n", label: "next" },
    { key: "p", label: "previous" },
    { key: "enter", label: "open" },
    { key: "b", label: "branches" },
    { key: "g", label: "history" },
    { key: "?", label: "all" },
  ];
}

export function panelPresentation(input: PanelPresentationInput): PanelPresentation {
  return {
    overviewTitle: overviewTitle(input),
    overviewMeta: overviewMeta(input),
    leftTitle: leftTitle(input),
    rightTitle: rightTitle(input),
    ...(input.status === undefined ? {} : { status: input.status }),
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
      { key: "n", label: "next row" },
      { key: "p", label: "previous row" },
      { key: "j/k", label: "scroll preview" },
      { key: "tab", label: "switch focus" },
      { key: "enter", label: "open / switch" },
      { key: "esc", label: "back / close" },
      { key: "?", label: "toggle help" },
    ],
  },
  {
    title: "Review",
    actions: [
      { key: "b", label: "branches" },
      { key: "g", label: "history" },
      { key: "r", label: "refresh" },
      { key: "s", label: "scope" },
      { key: "a", label: "view mode" },
    ],
  },
  {
    title: "Layout",
    actions: [
      { key: "d", label: "diff layout" },
      { key: "c", label: "diff context" },
      { key: "m", label: "highlight theme" },
      { key: "t", label: "tree width" },
      { key: "[", label: "shrink tree" },
      { key: "]", label: "grow tree" },
      { key: "\\", label: "collapse tree" },
    ],
  },
  {
    title: "Mouse",
    actions: [
      { key: "mouse", label: "click to select a visible row" },
    ],
  },
];
