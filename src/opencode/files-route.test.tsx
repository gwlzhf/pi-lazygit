/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { KeymapProvider } from "@opentui/keymap/solid";
import { RGBA } from "@opentui/core";
import { render } from "@opentui/solid";
import { createRoot } from "solid-js";
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { FilePreview, ProjectSnapshot, ReviewSource } from "../contracts";
import { DEFAULT_PANEL_SETTINGS, type PanelSettings, type PanelSettingsStore } from "../settings";
import type { ReviewControllerState } from "../ui/review-controller";
import type { ReviewController } from "../ui/review-controller";
import { copyFilesRouteSelection, createFilesRouteBindings, createFilesRouteKeyHandler, createFilesRouteMouseHandlers, diffColor, filesRouteMouseTarget, previewLines, routeDimensionsChanged, splitDiffColumns, splitSelectionSpans, FilesRoute } from "./files-route";
const theme = {
  primary: RGBA.fromHex("#ff00ff"), secondary: RGBA.fromHex("#aaaaaa"), accent: RGBA.fromHex("#00ffff"),
  error: RGBA.fromHex("#ff0000"), warning: RGBA.fromHex("#ffff00"), success: RGBA.fromHex("#00ff00"), info: RGBA.fromHex("#00aaff"),
  text: RGBA.fromHex("#ffffff"), textMuted: RGBA.fromHex("#888888"), selectedListItemText: RGBA.fromHex("#000000"),
  background: RGBA.fromHex("#000000"), backgroundPanel: RGBA.fromHex("#111111"), backgroundElement: RGBA.fromHex("#333333"), backgroundMenu: RGBA.fromHex("#222222"),
  border: RGBA.fromHex("#444444"), borderActive: RGBA.fromHex("#ff00ff"), borderSubtle: RGBA.fromHex("#222222"),
  diffAdded: RGBA.fromHex("#00ff00"), diffRemoved: RGBA.fromHex("#ff0000"), diffContext: RGBA.fromHex("#aaaaaa"), diffHunkHeader: RGBA.fromHex("#00ffff"),
  diffHighlightAdded: RGBA.fromHex("#00ff00"), diffHighlightRemoved: RGBA.fromHex("#ff0000"), diffAddedBg: RGBA.fromHex("#003300"), diffRemovedBg: RGBA.fromHex("#330000"), diffContextBg: RGBA.fromHex("#111111"), diffLineNumber: RGBA.fromHex("#777777"), diffAddedLineNumberBg: RGBA.fromHex("#003300"), diffRemovedLineNumberBg: RGBA.fromHex("#330000"),
  markdownText: RGBA.fromHex("#ffffff"), markdownHeading: RGBA.fromHex("#ffffff"), markdownLink: RGBA.fromHex("#ffffff"), markdownLinkText: RGBA.fromHex("#ffffff"), markdownCode: RGBA.fromHex("#ffffff"), markdownBlockQuote: RGBA.fromHex("#ffffff"), markdownEmph: RGBA.fromHex("#ffffff"), markdownStrong: RGBA.fromHex("#ffffff"), markdownHorizontalRule: RGBA.fromHex("#ffffff"), markdownListItem: RGBA.fromHex("#ffffff"), markdownListEnumeration: RGBA.fromHex("#ffffff"), markdownImage: RGBA.fromHex("#ffffff"), markdownImageText: RGBA.fromHex("#ffffff"), markdownCodeBlock: RGBA.fromHex("#ffffff"),
  syntaxComment: RGBA.fromHex("#888888"), syntaxKeyword: RGBA.fromHex("#ff00ff"), syntaxFunction: RGBA.fromHex("#00ffff"), syntaxVariable: RGBA.fromHex("#ffffff"), syntaxString: RGBA.fromHex("#00ff00"), syntaxNumber: RGBA.fromHex("#ffff00"), syntaxType: RGBA.fromHex("#00aaff"), syntaxOperator: RGBA.fromHex("#ffffff"), syntaxPunctuation: RGBA.fromHex("#ffffff"), thinkingOpacity: 1,
} as TuiThemeCurrent;

function snapshot(): ProjectSnapshot {
  const changes = new Map<string, { path: string; index: string; worktree: string; status: "M" }>([
    ["src/界.ts", { path: "src/界.ts", index: " ", worktree: "M", status: "M" }],
  ]);
  return {
    kind: "git", root: "/fixture", hasHead: true, currentBranch: "main", allFiles: ["src/界.ts", "README.md"],
    workspaceChanges: changes, sessionChanges: changes,
    workspaceSummary: { files: 1, insertions: 2, deletions: 1 }, sessionSummary: { files: 1, insertions: 2, deletions: 1 },
    workspaceSummaryByPath: new Map([["src/界.ts", { insertions: 2, deletions: 1 }]]),
    baselineEstablishedAt: Date.UTC(2026, 0, 2), truncated: false,
  };
}

type LocalBranchSnapshot = {
  readonly branches: readonly { readonly name: string; readonly current: boolean }[];
  readonly current?: string;
  readonly detachedAt?: string;
};

type RouteSource = ReviewSource & {
  readonly signals: AbortSignal[];
  readonly switches: string[];
  readonly branches: (options: { readonly signal: AbortSignal }) => Promise<LocalBranchSnapshot>;
  readonly switchBranch: (name: string, options: { readonly signal: AbortSignal }) => Promise<void>;
};

type SourceOptions = {
  readonly refresh?: Promise<ProjectSnapshot>;
  readonly preview?: Promise<FilePreview>;
  readonly watch?: (signal: AbortSignal) => Promise<void>;
  readonly branches?: Promise<LocalBranchSnapshot>;
  readonly switchBranch?: (name: string, signal: AbortSignal) => Promise<void>;
};

const defaultBranches: LocalBranchSnapshot = {
  branches: [{ name: "feature/ui", current: false }, { name: "main", current: true }],
  current: "main",
};

function controlledSource(options: SourceOptions = {}): RouteSource {
  const signals: AbortSignal[] = [];
  const switches: string[] = [];
  return {
    signals,
    switches,
    preview: async (_path, { signal }) => { signals.push(signal); return options.preview === undefined ? preview : options.preview; },
    history: async () => ({ entries: [{ oid: "abc", shortOid: "abc", subject: "Initial", author: "A", authoredAt: 0 }], truncated: false }),
    commitDiff: async () => ({ oid: "abc", kind: "diff", lines: ["@@ -1 +1 @@", "-old", "+new"], truncated: false }),
    branches: async ({ signal }) => {
      signals.push(signal);
      return options.branches === undefined ? defaultBranches : options.branches;
    },
    switchBranch: async (name, { signal }) => {
      switches.push(name);
      if (options.switchBranch !== undefined) await options.switchBranch(name, signal);
    },
    watch: async ({ signal }) => {
      signals.push(signal);
      if (options.watch !== undefined) return options.watch(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    refresh: async ({ signal }) => { signals.push(signal); return options.refresh === undefined ? snapshot() : options.refresh; },
  };
}

const preview: FilePreview = { path: "src/界.ts", kind: "text", lines: ["const 界 = true;", "return 界;"], truncated: false };


function settingsStore(): PanelSettingsStore & { readonly flushed: () => number } {
  let value: PanelSettings = DEFAULT_PANEL_SETTINGS;
  let flushCount = 0;
  return {
    load: async () => value,
    saveTreeRatio: ratio => { value = { ...value, treeRatio: ratio }; },
    saveTreeCollapsed: collapsed => { value = { ...value, treeCollapsed: collapsed }; },
    saveHighlightTheme: highlightTheme => { value = { ...value, highlightTheme }; },
    saveDiffLayout: diffLayout => { value = { ...value, diffLayout }; },
    saveDiffContext: diffContext => { value = { ...value, diffContext }; },
    flush: async () => { flushCount += 1; },
    flushed: () => flushCount,
  };
}

function api(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], modePushes: string[], copied: string[], toasts: unknown[], keymap: unknown): TuiPluginApi {
  return {
    mode: { current: () => "base", push: (mode: string) => { modePushes.push(mode); return () => modePushes.push("pop"); } },
    renderer,
    theme: { current: theme, selected: "default", has: () => true, set: () => true, install: async () => undefined, mode: () => "dark", ready: true },
    ui: { toast: (value: unknown) => toasts.push(value) },
    keymap,
  } as unknown as TuiPluginApi;
}

async function mount(width: number, height: number, source: ReviewSource, settings = settingsStore(), clipboard = true) {
  const setup = await createTestRenderer({ width, height });
  const layers: any[] = [];
  const keymap = { registerLayer: (layer: unknown) => { layers.push(layer); return () => undefined; } };
  const modePushes: string[] = [];
  const copied: string[] = [];
  const toasts: unknown[] = [];
  const rendererCopy = setup.renderer.copyToClipboardOSC52.bind(setup.renderer);
  const instance = api(setup.renderer, modePushes, copied, toasts, keymap);
  let disposeRoot = (): void => undefined;
  createRoot((dispose: () => void) => {
    disposeRoot = dispose;
    void render(() => <KeymapProvider keymap={keymap as never} children={(() => <FilesRoute api={instance} cwd="/fixture" settings={settings} createSource={() => source} onClose={() => modePushes.push("close")} />) as never} />, setup.renderer);
  });
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return { setup, layers, modePushes, copied, toasts, settings, rendererCopy, disposeRoot };
}
type CapturedTestFrame = {
  readonly lines: readonly {
    readonly spans: readonly {
      readonly text: string;
      readonly fg: RGBA;
      readonly bg: RGBA;
      readonly width: number;
    }[];
  }[];
};

type TestRouteBinding = {
  readonly key: string;
  readonly cmd: () => void;
};

type TestRouteLayer = {
  readonly bindings?: readonly TestRouteBinding[];
};

type MountedRouteBindings = {
  readonly layers: readonly TestRouteLayer[];
};

function invokeMountedBinding(mounted: MountedRouteBindings, key: string): void {
  for (const layer of mounted.layers) {
    const binding = layer.bindings?.find(candidate => candidate.key === key);
    if (binding !== undefined) {
      binding.cmd();
      return;
    }
  }
}

function expectSelectedRow(frame: CapturedTestFrame, text: string): void {
  const line = capturedLine(frame, text);
  expect(line).toBeDefined();
  if (line === undefined) return;
  expect(line.spans.some(span => span.bg.equals(theme.backgroundElement))).toBe(true);
  expect(line.spans.some(span => span.fg.equals(theme.selectedListItemText))).toBe(true);
  expect(spanWidth(line.spans.filter(span => span.bg.equals(theme.backgroundElement)))).toBeGreaterThan(text.length);
}

function capturedLine(frame: CapturedTestFrame, text: string) {
  return frame.lines.find(line => line.spans.some(span => span.text.includes(text)));
}

function spanWidth(spans: readonly { readonly width: number }[]): number {
  return spans.reduce((total, span) => total + span.width, 0);
}



describe("FilesRoute", () => {
  test("renders split and narrow native panes", async () => {
    const wide = await mount(100, 20, controlledSource());
    const wideFrame = wide.setup.captureCharFrame();
    expect(wideFrame).toContain("Preview");
    expect(wideFrame.split("\n").some(line => line.includes("│"))).toBe(true);
    wide.setup.renderer.destroy();

    const narrow = await mount(79, 10, controlledSource());
    const narrowFrame = narrow.setup.captureCharFrame();
    expect(narrowFrame).toContain("Project [modified · workspace]");
    expect(narrowFrame).not.toContain("const 界 = true;");
    narrow.setup.renderer.destroy();
  });
  
  test("repaints the tree once the first refresh resolves", async () => {
    const mounted = await mount(100, 20, controlledSource());
    const frame = mounted.setup.captureCharFrame();
    expect(frame).not.toContain("Loading project files");
    expect(frame).toContain("界.ts");
    mounted.setup.renderer.destroy();
  });

  test("normalizes primary keys while preserving preview scrolling and layered help escape", async () => {
    const mounted = await mount(100, 20, controlledSource());
    expect(mounted.modePushes).toContain("pi-lazygit.files");
    const calls: string[] = [];
    const state = {
      focus: "tree", leftMode: "files", treeCollapsed: false, rows: [], selectedIndex: 0,
      branches: defaultBranches, branchSelectedIndex: 0, branchLoading: false, branchSwitching: undefined, branchError: undefined,
    };
    const fake = {
      state,
      setViewMode: (mode: string) => calls.push(`mode:${mode}`),
      movePrimarySelection: (delta: number) => calls.push(`move:${delta}`),
      toggleFocus: () => calls.push("focus"),
      resizeTree: (delta: number) => calls.push(`resize:${delta}`),
      toggleLeftMode: () => calls.push("history"),
      toggleBranches: () => calls.push("branches"),
      switchSelectedBranch: () => calls.push("switch"),
      focusPreview: () => { state.focus = "preview"; calls.push("preview"); },
      focusTree: () => { state.focus = "tree"; calls.push("tree"); },
      setTreeCollapsed: () => calls.push("collapsed"),
      toggleDiffLayout: () => calls.push("diff"),
      cycleDiffContext: () => calls.push("context"),
      toggleScope: () => calls.push("scope"),
      toggleListLayout: () => calls.push("list-layout"),
      collapseOrParent: () => calls.push("parent"),
      expandOrChild: () => calls.push("child"),
      openSelection: () => calls.push("open"),
      refresh: () => calls.push("refresh"),
      scrollPreviewHome: () => calls.push("home"),
      scrollPreviewEnd: () => calls.push("end"),
      scrollPreview: () => calls.push("scroll"),
    } as unknown as ReviewController;
    let helpVisible = false;
    const handler = createFilesRouteKeyHandler({
      getController: () => fake,
      isDisposed: () => false,
      width: () => 100,
      viewportHeight: () => 10,
      clearSelection: () => undefined,
      scrollPreview: () => calls.push("scroll"),
      focusTreeOrClose: () => {
        if (helpVisible) { helpVisible = false; calls.push("help-close"); }
        else if (state.focus === "preview") { state.focus = "tree"; calls.push("tree"); }
        else calls.push("close");
      },
      isHelpVisible: () => helpVisible,
      toggleHelp: () => { helpVisible = !helpVisible; calls.push(helpVisible ? "help-open" : "help-close"); },
    } as unknown as Parameters<typeof createFilesRouteKeyHandler>[0]);
    const bindings = createFilesRouteBindings(handler);
    expect(["n", "p", "b", "?"].every(key => bindings.some(binding => binding.key === key))).toBe(true);
    const invoke = (key: string): void => bindings.find(binding => binding.key === key)?.cmd();

    invoke("r"); invoke("a"); invoke("down"); invoke("tab"); invoke("]"); invoke("escape");
    expect(calls.slice(0, 6)).toEqual(["refresh", "mode:all", "move:1", "focus", "resize:1", "close"]);

    state.focus = "tree";
    state.leftMode = "files";
    const beforeFilesJk = calls.length;
    invoke("j"); invoke("k");
    expect(calls).toHaveLength(beforeFilesJk);
    invoke("n"); invoke("p");
    expect(calls.slice(-2)).toEqual(["move:1", "move:-1"]);

    // v swaps the directory tree for the change list, and only in the files pane.
    invoke("v");
    expect(calls.at(-1)).toBe("list-layout");

    state.leftMode = "log";
    const beforeLogJk = calls.length;
    invoke("j"); invoke("k");
    expect(calls).toHaveLength(beforeLogJk);
    invoke("n"); invoke("p");
    expect(calls.slice(-2)).toEqual(["move:1", "move:-1"]);

    state.leftMode = "branches";
    const beforeBranchJk = calls.length;
    invoke("j"); invoke("k");
    expect(calls).toHaveLength(beforeBranchJk);
    invoke("n"); invoke("p"); invoke("enter");
    expect(calls.slice(-3)).toEqual(["move:1", "move:-1", "switch"]);
    invoke("b");
    expect(calls.at(-1)).toBe("branches");

    state.focus = "preview";
    invoke("j"); invoke("k");
    expect(calls.slice(-2)).toEqual(["scroll", "scroll"]);

    const closeCount = calls.filter(call => call === "close").length;
    invoke("?");
    expect(calls.at(-1)).toBe("help-open");
    invoke("escape");
    expect(calls.at(-1)).toBe("help-close");
    expect(calls.filter(call => call === "close")).toHaveLength(closeCount);
    mounted.setup.renderer.destroy();
  });
  test("renders overview metadata, contextual actions, and padded native selected rows", async () => {
    const mounted = await mount(100, 20, controlledSource());
    const overview = mounted.setup.captureCharFrame();
    expect(overview).toContain("Diff working tree");
    expect(overview).toContain("main");
    expect(overview).toContain("+2 -1");
    for (const key of ["n", "p", "b", "?"]) expect(overview).toContain(key);
    expect(overview).toMatch(/Enter|enter/);
    expectSelectedRow(mounted.setup.captureSpans(), "界.ts");

    invokeMountedBinding(mounted, "g");
    await mounted.setup.flush();
    const history = mounted.setup.captureCharFrame();
    expect(history).toContain("History");
    expectSelectedRow(mounted.setup.captureSpans(), "abc");

    invokeMountedBinding(mounted, "b");
    await mounted.setup.flush();
    const branches = mounted.setup.captureCharFrame();
    expect(branches).toContain("Switch branch");
    expect(branches).toContain("feature/ui");
    expectSelectedRow(mounted.setup.captureSpans(), "main");
    mounted.setup.renderer.destroy();
  });

  test("masks unified and split diff cells with host backgrounds without covering selected text", async () => {
    const diff: FilePreview = {
      path: "src/界.ts",
      kind: "diff",
      lines: ["@@ -1,2 +1,2 @@", " context", "-removed", "+added"],
      truncated: false,
    };
    const mounted = await mount(100, 20, controlledSource({ preview: Promise.resolve(diff) }));
    const unified = mounted.setup.captureSpans();
    const added = capturedLine(unified, "+added");
    const removed = capturedLine(unified, "-removed");
    const context = capturedLine(unified, "context");
    expect(added).toBeDefined();
    expect(removed).toBeDefined();
    expect(context).toBeDefined();
    expect(added!.spans.some(span => span.bg.equals(theme.diffAddedBg))).toBe(true);
    expect(removed!.spans.some(span => span.bg.equals(theme.diffRemovedBg))).toBe(true);
    expect(context!.spans.some(span => span.bg.equals(theme.diffContextBg))).toBe(true);

    invokeMountedBinding(mounted, "d");
    await mounted.setup.flush();
    const split = mounted.setup.captureSpans();
    const splitAdded = capturedLine(split, "+added");
    const splitRemoved = capturedLine(split, "-removed");
    expect(splitAdded).toBeDefined();
    expect(splitRemoved).toBeDefined();
    expect(splitAdded!.spans.some(span => span.bg.equals(theme.diffAddedBg))).toBe(true);
    expect(splitRemoved!.spans.some(span => span.bg.equals(theme.diffRemovedBg))).toBe(true);
    expect(spanWidth(splitAdded!.spans.filter(span => span.bg.equals(theme.diffAddedBg)))).toBeGreaterThan(1);
    expect(spanWidth(splitRemoved!.spans.filter(span => span.bg.equals(theme.diffRemovedBg)))).toBeGreaterThan(1);

    // Row 0 is the overview header and row 1 the pane-title border, so the paired diff row
    // that carries "+added" sits at screen row 4.
    await mounted.setup.mockMouse.drag(33, 4, 39, 4);
    await mounted.setup.flush();
    const selected = capturedLine(mounted.setup.captureSpans(), "+added");
    expect(selected).toBeDefined();
    expect(selected!.spans.some(span => span.fg.equals(theme.selectedListItemText) && span.bg.equals(theme.backgroundElement))).toBe(true);
    mounted.setup.renderer.destroy();
  });

  test("cleanup aborts source work and flushes settings", async () => {
    const source = controlledSource();
    const mounted = await mount(100, 20, source);
    const signalCount = source.signals.length;
    mounted.setup.renderer.destroy();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(source.signals.some(signal => signal.aborted)).toBe(true);
    expect(source.signals.length).toBe(signalCount);
    expect(mounted.settings.flushed()).toBe(1);
  });
  test("copies preview selections through OSC52 and warns on failure", () => {
    const selection = { anchor: { row: 0, col: 0 }, head: { row: 0, col: 5 } };
    let copied = "";
    let warned = false;
    const notice = copyFilesRouteSelection(selection, ["const 界 = true;"], 20, text => { copied = text; return true; }, () => { warned = true; });
    expect(copied).toContain("const");
    expect(notice).toBe("copied 1 line");
    const failed = copyFilesRouteSelection(selection, ["const 界 = true;"], 20, () => false, () => { warned = true; });
    expect(failed).toBeUndefined();
    expect(warned).toBe(true);
  });

  test("production mouse target helper routes divider, tree, and preview panes", () => {
    const state: { focus: "tree" | "preview"; treeRatio: number } = { focus: "tree", treeRatio: 0.3 };
    const routeState = state as unknown as ReviewControllerState;
    const mouse = (x: number) => ({ x, y: 2 } as never);
    expect(filesRouteMouseTarget(mouse(0), routeState, 100)).toBe("tree");
    state.focus = "preview";
    expect(filesRouteMouseTarget(mouse(99), routeState, 100)).toBe("preview");
    const divider = Array.from({ length: 100 }, (_, x) => x).find(x => filesRouteMouseTarget(mouse(x), routeState, 100) === "divider");
    expect(divider).toBeDefined();
  });
  test("production mouse handlers resize divider and release preview copy", () => {
    const state = {
      focus: "tree", leftMode: "files", treeCollapsed: false, treeRatio: 0.3, rows: [], selectedIndex: 0,
    };
    const routeState = state as unknown as ReviewControllerState;
    const calls: string[] = [];
    const fake = {
      state: routeState,
      setTreeColumns: (column: number) => calls.push(`resize:${column}`),
      focusTree: () => calls.push("tree"),
      focusPreview: () => { state.focus = "preview"; calls.push("preview"); },
      selectPrimary: (index: number) => calls.push(`select:${index}`),
    } as unknown as ReviewController;
    let selection: { readonly anchor: { readonly row: number; readonly col: number }; readonly head: { readonly row: number; readonly col: number } } | undefined;
    let selecting = false;
    let divider = false;
    let clipboard = true;
    let copied = "";
    let warned = false;
    const handlers = createFilesRouteMouseHandlers({
      getController: () => fake,
      isDisposed: () => false,
      width: () => 100,
      viewportHeight: () => 10,
      treeOffset: () => 0,
      logOffset: () => 0,
      branchOffset: () => 0,
      getSelection: () => selection,
      setSelection: (value: typeof selection) => { selection = value; },
      isSelectionDrag: () => selecting,
      setSelectionDrag: (value: boolean) => { selecting = value; },
      isDividerDrag: () => divider,
      setDividerDrag: (value: boolean) => { divider = value; },
      clearSelection: () => { selection = undefined; },
      bumpRevision: () => undefined,
      copySelection: () => {
        const notice = copyFilesRouteSelection(selection, ["const 界 = true;"], 20, text => { copied = text; return clipboard; }, () => { warned = true; });
        if (notice !== undefined) calls.push(notice);
      },
    } as unknown as Parameters<typeof createFilesRouteMouseHandlers>[0]);
    const mouse = (x: number) => ({ x, y: 2 } as never);
    const dividerColumn = Array.from({ length: 100 }, (_, x) => x).find(x => filesRouteMouseTarget(mouse(x), routeState, 100) === "divider")!;
    handlers.onMouseDown(mouse(dividerColumn));
    handlers.onMouseDrag(mouse(dividerColumn + 3));
    handlers.onMouseUp();
    expect(calls).toContain(`resize:${dividerColumn + 3}`);
    handlers.onMouseDown(mouse(dividerColumn + 2));
    handlers.onMouseDrag(mouse(dividerColumn + 8));
    handlers.onMouseUp();
    expect(copied.length).toBeGreaterThan(0);
    clipboard = false;
    handlers.onMouseDown(mouse(dividerColumn + 2));
    handlers.onMouseDrag(mouse(dividerColumn + 8));
    handlers.onMouseUp();
    expect(warned).toBe(true);
  });
  test("maps files, history, and branch clicks below the overview and ignores chrome or padding", () => {
    const state = {
      focus: "tree", leftMode: "files", treeCollapsed: true, treeRatio: 0.3,
      rows: Array.from({ length: 8 }, () => ({})), selectedIndex: 0,
      branches: { branches: Array.from({ length: 8 }, (_, index) => ({ name: `branch-${index}`, current: index === 0 })), current: "branch-0" },
      branchSelectedIndex: 0,
    };
    const routeState = state as unknown as ReviewControllerState;
    const calls: string[] = [];
    let width = 40;
    const fake = {
      state: routeState,
      focusTree: () => calls.push("tree"),
      focusPreview: () => calls.push("preview"),
      selectPrimary: (index: number) => calls.push(`select:${index}`),
      switchSelectedBranch: () => calls.push("switch"),
      setTreeColumns: (column: number) => calls.push(`resize:${column}`),
    } as unknown as ReviewController;
    let selection: { readonly anchor: { readonly row: number; readonly col: number }; readonly head: { readonly row: number; readonly col: number } } | undefined;
    let selectionDrag = false;
    let dividerDrag = false;
    const handlers = createFilesRouteMouseHandlers({
      getController: () => fake,
      isDisposed: () => false,
      width: () => width,
      viewportHeight: () => 3,
      treeOffset: () => 4,
      logOffset: () => 2,
      branchOffset: () => 5,
      getSelection: () => selection,
      setSelection: (value: typeof selection) => { selection = value; },
      isSelectionDrag: () => selectionDrag,
      setSelectionDrag: (value: boolean) => { selectionDrag = value; },
      isDividerDrag: () => dividerDrag,
      setDividerDrag: (value: boolean) => { dividerDrag = value; },
      clearSelection: () => { selection = undefined; },
      bumpRevision: () => undefined,
      copySelection: () => undefined,
    } as unknown as Parameters<typeof createFilesRouteMouseHandlers>[0]);
    const mouse = (x: number, y: number) => ({ x, y } as never);

    handlers.onMouseDown(mouse(2, 0));
    handlers.onMouseDown(mouse(2, 1));
    expect(calls).toEqual([]);

    handlers.onMouseDown(mouse(2, 2));
    expect(calls).toContain("select:4");
    state.leftMode = "log";
    handlers.onMouseDown(mouse(2, 3));
    expect(calls).toContain("select:3");
    state.leftMode = "branches";
    handlers.onMouseDown(mouse(2, 4));
    expect(calls).toContain("select:7");
    expect(calls).not.toContain("switch");

    state.branches = { branches: [{ name: "only", current: true }], current: "only" };
    handlers.onMouseDown(mouse(2, 3));
    handlers.onMouseDown(mouse(2, 5));
    expect(calls.filter(call => call.startsWith("select:"))).toHaveLength(3);

    width = 100;
    state.treeCollapsed = false;
    state.leftMode = "files";
    state.focus = "tree";
    const dividerColumn = Array.from({ length: 100 }, (_, x) => x).find(x => filesRouteMouseTarget(mouse(x, 2), routeState, width) === "divider")!;
    handlers.onMouseDown(mouse(dividerColumn, 2));
    expect(dividerDrag).toBe(true);
    handlers.onMouseUp();
    state.focus = "preview";
    handlers.onMouseDown(mouse(dividerColumn + 2, 2));
    expect(selectionDrag).toBe(true);
    expect(calls.at(-1)).toBe("preview");
  });
  test("retires selection state whenever renderer dimensions change", () => {
    expect(routeDimensionsChanged(undefined, { width: 100, height: 20 })).toBe(false);
    expect(routeDimensionsChanged({ width: 100, height: 20 }, { width: 101, height: 20 })).toBe(true);
    expect(routeDimensionsChanged({ width: 100, height: 20 }, { width: 100, height: 21 })).toBe(true);
    expect(routeDimensionsChanged({ width: 100, height: 20 }, { width: 100, height: 20 })).toBe(false);
  });

  test("numbers ordinary text previews and keeps host text token", () => {
    const state = {} as ReviewControllerState;
    const lines = previewLines({ ...preview, lines: ["alpha", "beta"] }, state, 80);
    expect(lines.map(line => line.text)).toEqual(["1 alpha", "2 beta"]);
    expect(lines.every(line => line.kind === "text")).toBe(true);
    expect(diffColor("text", theme)).toBe(theme.text);
  });

  test("pads split diff columns to equal halves so both sides align", () => {
    const state = { diffLayout: "split" } as ReviewControllerState;
    const diff = { path: "src/a.ts", kind: "diff", truncated: false, lines: ["@@ -1,2 +1,2 @@", " keep", "-old", "+new"] } as FilePreview;
    const width = 41;
    const lines = previewLines(diff, state, width);
    const pairs = lines.filter(line => line.right !== undefined);
    expect(pairs.length).toBe(2);
    for (const line of pairs) {
      expect(line.text.length).toBe(splitDiffColumns(width).left);
      expect(line.right!.text.length).toBe(splitDiffColumns(width).right);
    }
    expect(pairs[0]!.text).toStartWith("1  keep");
    expect(pairs[1]!.text).toStartWith("2 -old");
    expect(pairs[1]!.right!.text).toStartWith("2 +new");
    expect(splitDiffColumns(width).left + splitDiffColumns(width).right + 1).toBe(width);
    // Narrow previews keep the unified layout.
    expect(previewLines(diff, state, 39).every(line => line.right === undefined)).toBe(true);
  });

  test("clips split selection spans independently while retaining side boundaries", () => {
    expect(splitSelectionSpans({ row: 0, from: 2, to: 15 }, 8, 5, 8)).toEqual({
      left: { row: 0, from: 2, to: 8 },
      right: { row: 0, from: 0, to: 2 },
    });
  });
  test("diff rendering reads live host theme tokens", () => {
    const alternate = { ...theme, diffAdded: RGBA.fromHex("#123456") };
    expect(diffColor("add", theme)).toBe(theme.diffAdded);
    expect(diffColor("add", alternate)).toBe(alternate.diffAdded);
    expect(diffColor("remove", alternate)).toBe(alternate.diffRemoved);
  });

});
