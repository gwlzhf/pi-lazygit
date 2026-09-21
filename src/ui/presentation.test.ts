import { expect, test } from "bun:test";
import {
  PANEL_HELP_GROUPS,
  panelPresentation,
  type PanelAction,
  type PanelPresentationInput,
} from "./presentation";

type PresentationOverrides = Omit<
  Partial<PanelPresentationInput>,
  "sourceKind" | "currentBranch" | "detachedAt"
> & {
  readonly sourceKind?: PanelPresentationInput["sourceKind"] | undefined;
  readonly currentBranch?: string | undefined;
  readonly detachedAt?: string | undefined;
};

function input(overrides: PresentationOverrides = {}): PanelPresentationInput {
  return {
    sourceKind: "git",
    leftMode: "files",
    focus: "tree",
    viewMode: "modified",
    scope: "workspace",
    currentBranch: "main",
    fileCount: 6,
    ...overrides,
  } as PanelPresentationInput;
}
function actions(...values: readonly string[]): readonly PanelAction[] {
  return values.map(value => {
    const separator = value.indexOf(" ");
    return {
      key: value.slice(0, separator),
      label: value.slice(separator + 1),
    };
  });
}

test("presents the working-tree files view with exact metadata, titles, and action order", () => {
  expect(panelPresentation(input({
    selectedPath: "src/a.ts",
    selectedSummary: { insertions: 3, deletions: 1 },
  }))).toEqual({
    overviewTitle: "Diff working tree",
    overviewMeta: "main · 6 files",
    leftTitle: "Files",
    rightTitle: "src/a.ts · +3 -1",
    actions: actions(
      "tab focus preview",
      "n next",
      "p previous",
      "enter open",
      "b branches",
      "g history",
      "? all",
    ),
  });
});

test("presents session, history, branches, filesystem, and detached views", () => {
  expect(panelPresentation(input({ scope: "session" })).overviewTitle).toBe("Diff session");
  expect(panelPresentation(input({ leftMode: "log", selectedPath: "abc1234" }))).toEqual({
    overviewTitle: "History",
    overviewMeta: "main · 6 files",
    leftTitle: "History",
    rightTitle: "abc1234",
    actions: actions(
      "tab focus preview",
      "n next",
      "p previous",
      "enter open",
      "g files",
      "b branches",
      "? all",
    ),
  });
  expect(panelPresentation(input({ leftMode: "branches" }))).toEqual({
    overviewTitle: "Switch branch",
    overviewMeta: "main · 6 files",
    leftTitle: "Branches",
    rightTitle: "Preview",
    actions: actions(
      "n next",
      "p previous",
      "enter switch",
      "b files",
      "? all",
    ),
  });
  expect(panelPresentation(input({ sourceKind: "filesystem", currentBranch: undefined }))).toEqual({
    overviewTitle: "Project files",
    overviewMeta: "6 files",
    leftTitle: "Files",
    rightTitle: "Preview",
    actions: actions("tab focus preview", "n next", "p previous", "enter open", "? all"),
  });
  expect(panelPresentation(input({ detachedAt: "abc1234", currentBranch: undefined })).overviewMeta)
    .toBe("detached abc1234 · 6 files");
});

test("uses selected paths and summaries only when present, and preserves status priority", () => {
  expect(panelPresentation(input({ fileCount: 1, selectedPath: "猫.ts" })).rightTitle).toBe("猫.ts");
  expect(panelPresentation(input({ selectedPath: "猫.ts", selectedSummary: { insertions: 0, deletions: 0 } })).rightTitle)
    .toBe("猫.ts · +0 -0");
  expect(panelPresentation(input({ status: "watch error: denied" })).status).toBe("watch error: denied");
  expect(panelPresentation(input({ status: "switching" })).status).toBe("switching");
});

test("publishes complete grouped help in stable order", () => {
  expect(PANEL_HELP_GROUPS.map(group => group.title)).toEqual([
    "Navigation",
    "Review",
    "Layout",
    "Mouse",
  ]);
  for (const group of PANEL_HELP_GROUPS) {
    expect(group.actions.length).toBeGreaterThan(0);
    for (const action of group.actions) {
      expect(action.key.length).toBeGreaterThan(0);
      expect(action.label.length).toBeGreaterThan(0);
    }
  }
  const allActions = PANEL_HELP_GROUPS.flatMap(group => group.actions.map(action => `${action.key} ${action.label}`));
  expect(allActions).toEqual(expect.arrayContaining([
    "tab focus preview",
    "n next",
    "p previous",
    "enter open",
    "b branches",
    "? all",
    "j/k scroll",
    "d layout",
    "c context",
  ]));
});
