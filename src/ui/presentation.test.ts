import { expect, test } from "bun:test";
import type { FileLineSummary } from "../contracts";
import { PANEL_HELP_GROUPS, panelPresentation } from "./presentation";

const summary: FileLineSummary = { insertions: 3, deletions: 1 };

type InputOverrides = {
  [K in keyof Parameters<typeof panelPresentation>[0]]?: Parameters<typeof panelPresentation>[0][K] | undefined;
};

function input(overrides: InputOverrides = {}): Parameters<typeof panelPresentation>[0] {
  const base: Record<string, unknown> = {
    sourceKind: "git",
    leftMode: "files",
    focus: "tree",
    viewMode: "modified",
    scope: "workspace",
    currentBranch: "main",
    fileCount: 2,
    selectedPath: "src/a.ts",
    selectedSummary: summary,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base as unknown as Parameters<typeof panelPresentation>[0];
}

test("presents the working-tree files view with exact titles, metadata, and actions", () => {
  expect(panelPresentation(input())).toEqual({
    overviewTitle: "Diff working tree",
    overviewMeta: "main · 2 files",
    leftTitle: "Files",
    rightTitle: "src/a.ts · +3 -1",
    actions: [
      { key: "tab", label: "focus preview" },
      { key: "n", label: "next" },
      { key: "p", label: "previous" },
      { key: "enter", label: "open" },
      { key: "b", label: "branches" },
      { key: "g", label: "history" },
      { key: "?", label: "all" },
    ],
  });
});

test("uses session, preview, history, branch, filesystem, detached, and error presentation policy", () => {
  expect(panelPresentation(input({ scope: "session", focus: "preview", selectedPath: undefined, selectedSummary: undefined }))).toEqual({
    overviewTitle: "Diff session",
    overviewMeta: "main · 2 files",
    leftTitle: "Files",
    rightTitle: "Preview",
    actions: [
      { key: "tab", label: "focus tree" },
      { key: "j/k", label: "scroll" },
      { key: "d", label: "layout" },
      { key: "c", label: "context" },
      { key: "b", label: "branches" },
      { key: "?", label: "all" },
    ],
  });
  expect(panelPresentation(input({ leftMode: "log", focus: "tree" }))).toMatchObject({
    overviewTitle: "History",
    leftTitle: "History",
    rightTitle: "src/a.ts · +3 -1",
  });
  expect(panelPresentation(input({ leftMode: "branches", focus: "tree" }))).toMatchObject({
    overviewTitle: "Switch branch",
    leftTitle: "Branches",
    rightTitle: "src/a.ts · +3 -1",
  });
  expect(panelPresentation(input({ sourceKind: "filesystem", viewMode: "all", currentBranch: undefined, selectedSummary: undefined }))).toMatchObject({
    overviewTitle: "Project files",
    overviewMeta: "2 files",
    leftTitle: "Files",
  });
  expect(panelPresentation(input({ currentBranch: undefined, detachedAt: "abc1234" })).overviewMeta).toBe("detached abc1234 · 2 files");
  expect(panelPresentation(input({ currentBranch: undefined, detachedAt: undefined, status: "switch refused" })).status).toBe("switch refused");
});

test("exports complete grouped help with every documented primary action", () => {
  expect(PANEL_HELP_GROUPS.map(group => group.title)).toEqual(["Navigation", "Review", "Layout", "Mouse"]);
  const actions = PANEL_HELP_GROUPS.flatMap(group => group.actions);
  for (const key of ["n", "p", "j/k", "b", "enter", "tab", "?", "esc", "d", "c", "m", "a", "s", "g", "r", "\\", "t", "[", "]"]) {
    expect(actions.filter(action => action.key === key), `help key ${key}`).toHaveLength(1);
  }
  expect(actions.some(action => action.key === "mouse" && action.label.includes("select"))).toBe(true);
});
