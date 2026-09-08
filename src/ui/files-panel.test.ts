import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type {
  ChangeRecord,
  FilePreview,
  ProjectSnapshot,
  ReviewSource,
  StatusCode,
} from "../contracts";
import { FilesPanel, type FilesPanelOptions } from "./files-panel";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface Pending<T> {
  readonly signal: AbortSignal;
  readonly value: Deferred<T>;
}

class ControlledSource implements ReviewSource {
  readonly refreshCalls: Pending<ProjectSnapshot>[] = [];
  readonly previewCalls: (Pending<FilePreview> & { readonly path: string })[] = [];

  refresh({ signal }: { readonly signal: AbortSignal }): Promise<ProjectSnapshot> {
    const value = deferred<ProjectSnapshot>();
    this.refreshCalls.push({ signal, value });
    return value.promise;
  }

  preview(path: string, { signal }: { readonly signal: AbortSignal }): Promise<FilePreview> {
    const value = deferred<FilePreview>();
    this.previewCalls.push({ path, signal, value });
    return value.promise;
  }
}

function change(path: string, status: StatusCode): ChangeRecord {
  return { path, index: " ", worktree: status, status };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    kind: "git",
    root: "C:/repo",
    hasHead: true,
    allFiles: ["src/a.ts", "src/b.ts", "README.md"],
    workspaceChanges: new Map([
      ["src/a.ts", change("src/a.ts", "M")],
      ["src/b.ts", change("src/b.ts", "A")],
    ]),
    sessionChanges: new Map([["src/b.ts", change("src/b.ts", "A")]]),
    workspaceSummary: { files: 2, insertions: 3, deletions: 1 },
    sessionSummary: { files: 1, insertions: 1, deletions: 0 },
    truncated: false,
    ...overrides,
  };
}

function preview(
  path: string,
  kind: FilePreview["kind"] = "text",
  lines: readonly string[] = ["content"],
  overrides: Partial<FilePreview> = {},
): FilePreview {
  return { path, kind, lines, truncated: false, ...overrides };
}

function plainTheme(): Theme {
  return {
    fg(_color: ThemeColor, text: string): string {
      return text;
    },
    bold(text: string): string {
      return text;
    },
  } as unknown as Theme;
}

interface FakeTui extends TUI {
  renderRequests: number;
  setRows(rows: number): void;
}

function fakeTui(columns = 100, rows = 7): FakeTui {
  const value = {
    terminal: { columns, rows },
    renderRequests: 0,
    requestRender(): void {
      this.renderRequests += 1;
    },
    setRows(next: number): void {
      this.terminal.rows = next;
    },
  };
  return value as unknown as FakeTui;
}

function keybindings(): KeybindingsManager {
  return {
    matches(data: string, binding: string): boolean {
      return binding === "app.interrupt" && data === "\x03";
    },
  } as unknown as KeybindingsManager;
}

function harness(columns = 100, rows = 7, overrides: Partial<FilesPanelOptions> = {}): {
  readonly panel: FilesPanel;
  readonly source: ControlledSource;
  readonly tui: FakeTui;
  readonly doneResults: undefined[];
  readonly ratios: number[];
} {
  const source = new ControlledSource();
  const tui = fakeTui(columns, rows);
  const doneResults: undefined[] = [];
  const ratios: number[] = [];
  const panel = new FilesPanel({
    cwd: "C:/repo",
    source,
    tui,
    theme: plainTheme(),
    keybindings: keybindings(),
    sessionName: "demo",
    onTreeRatioChange: ratio => ratios.push(ratio),
    done: result => doneResults.push(result),
    ...overrides,
  });
  return { panel, source, tui, doneResults, ratios };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function expectWidthSafe(lines: readonly string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe("FilesPanel state machine", () => {
  test("starts in modified workspace tree focus and rebuilds rows for a, m, and s", async () => {
    const { panel, source } = harness(60, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    const initial = panel.render(60);
    expect(initial[0]).toBe(`┌─ Project [modified · workspace] ${"─".repeat(25)}┐`);
    expect(initial.join("\n")).toContain("M  a.ts");
    expect(initial.join("\n")).toContain("A  b.ts");
    expect(initial.join("\n")).not.toContain("README.md");

    panel.handleInput("a");
    expect(panel.render(60).join("\n")).toContain("README.md");

    panel.handleInput("s");
    const allSession = panel.render(60).join("\n");
    expect(allSession).toContain("Project [all · session]");
    expect(allSession).toContain("   a.ts");
    expect(allSession).toContain("A  b.ts");
    expect(allSession).toContain("README.md");

    panel.handleInput("m");
    const modifiedSession = panel.render(60).join("\n");
    expect(modifiedSession).toContain("Project [modified · session]");
    expect(modifiedSession).not.toContain("a.ts");
    expect(modifiedSession).toContain("b.ts");
  });

  test("ignores mode and scope keys for filesystem snapshots", async () => {
    const { panel, source, tui } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot({
      kind: "filesystem",
      allFiles: ["src/a.ts", "README.md"],
      workspaceChanges: new Map(),
      sessionChanges: new Map(),
      workspaceSummary: { files: 0, insertions: 0, deletions: 0 },
      sessionSummary: { files: 0, insertions: 0, deletions: 0 },
    }));
    await settle();
    const rendered = panel.render(60);
    const requests = tui.renderRequests;
    panel.handleInput("m");
    panel.handleInput("s");
    expect(panel.render(60)).toBe(rendered);
    expect(tui.renderRequests).toBe(requests);
    expect(rendered[0]).toContain("Project [filesystem]");
    expect(rendered.join("\n")).toContain("README.md");
  });

  test("navigates, collapses, expands, and starts file previews on selection", async () => {
    const { panel, source } = harness(60, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("h");
    expect(panel.render(60).join("\n")).not.toContain("a.ts");
    panel.handleInput("l");
    expect(panel.render(60).join("\n")).toContain("a.ts");
    panel.handleInput("\x1b[B");
    expect(source.previewCalls.at(-1)?.path).toBe("src/a.ts");
    panel.handleInput("j");
    expect(source.previewCalls.at(-1)?.path).toBe("src/b.ts");
    expect(source.previewCalls.at(-2)?.signal.aborted).toBe(true);
    panel.handleInput("k");
    expect(source.previewCalls.at(-1)?.path).toBe("src/a.ts");
    panel.handleInput("\x1b[A");
    expect(panel.render(60).join("\n")).toContain("> ▼ src/");
  });

  test("Enter on a file focuses preview and scrolling clamps", async () => {
    const { panel, source } = harness(60, 5);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)));
    await settle();
    panel.handleInput("\r");
    expect(panel.render(60)).toEqual([
      `┌─ File: src/a.ts ${"─".repeat(41)}┐`,
      `│${" 1 line 1".padEnd(58)}│`,
      `│${" 2 line 2".padEnd(58)}│`,
      `│${" 3 line 3".padEnd(58)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · ↑↓ scrol┘",
    ]);
    panel.handleInput("\x1b[F");
    panel.handleInput("\x1b[B");
    expect(panel.render(60).slice(1, 4)).toEqual([
      `│${" 8 line 8".padEnd(58)}│`,
      `│${" 9 line 9".padEnd(58)}│`,
      `│${"10 line 10".padEnd(58)}│`,
    ]);
    panel.handleInput("\x1b[H");
    panel.handleInput("\x1b[A");
    expect(panel.render(60)[1]).toBe(`│${" 1 line 1".padEnd(58)}│`);
    panel.handleInput("\x1b[6~");
    expect(panel.render(60)[1]).toBe(`│${" 4 line 4".padEnd(58)}│`);
    panel.handleInput("\x1b[5~");
    expect(panel.render(60)[1]).toBe(`│${" 1 line 1".padEnd(58)}│`);
  });

  test("Esc returns to tree before closing and done is idempotent", async () => {
    const { panel, source, doneResults } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    panel.handleInput("\x1b");
    expect(panel.render(60)[0]).toContain("Project");
    expect(doneResults).toHaveLength(0);
    panel.handleInput("\x03");
    panel.handleInput("\x1b");
    expect(doneResults).toEqual([undefined]);
  });

  test("refresh retains a surviving selected path", async () => {
    const { panel, source } = harness(60, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    expect(panel.render(60).join("\n")).toContain(">   A  b.ts");
    panel.handleInput("r");
    source.refreshCalls[1]?.value.resolve(snapshot({ allFiles: ["src/b.ts", "src/c.ts", "README.md"] }));
    await settle();
    expect(panel.render(60).join("\n")).toContain(">   A  b.ts");
    expect(source.previewCalls.at(-1)?.path).toBe("src/b.ts");
  });

  test("refresh keeps the resolved preview visible while loading its replacement", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["before refresh"]));
    await settle();

    panel.handleInput("r");
    expect(panel.render(100).join("\n")).toContain("before refresh");
    source.refreshCalls[1]?.value.resolve(snapshot());
    await settle();
    expect(source.previewCalls.at(-1)?.path).toBe("src/a.ts");
    expect(panel.render(100).join("\n")).toContain("before refresh");

    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["after refresh"]));
    await settle();
    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("after refresh");
    expect(rendered).not.toContain("before refresh");
  });

  test("rejected refresh preserves the last resolved preview", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["stable preview"]));
    await settle();

    panel.handleInput("r");
    source.refreshCalls[1]?.value.reject(new Error("refresh failed"));
    await settle();

    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("stable preview");
    expect(rendered).toContain("error: refresh failed");
  });

  test("late preview and refresh generations cannot replace newer results", async () => {
    const { panel, source, tui } = harness(60, 6);
    panel.start();
    const refreshA = source.refreshCalls[0];
    panel.handleInput("r");
    const refreshB = source.refreshCalls[1];
    refreshB?.value.resolve(snapshot());
    await settle();
    const afterRefreshB = tui.renderRequests;
    refreshA?.value.resolve(snapshot({ allFiles: ["old.ts"], workspaceChanges: new Map([["old.ts", change("old.ts", "M")]]) }));
    await settle();
    expect(panel.render(60).join("\n")).not.toContain("old.ts");
    expect(tui.renderRequests).toBe(afterRefreshB);

    panel.handleInput("\x1b[B");
    const previewA = source.previewCalls.at(-1);
    panel.handleInput("\x1b[B");
    const previewB = source.previewCalls.at(-1);
    panel.handleInput("\r");
    previewB?.value.resolve(preview("src/b.ts", "text", ["newer B"]));
    await settle();
    const afterPreviewB = tui.renderRequests;
    previewA?.value.resolve(preview("src/a.ts", "text", ["stale A"]));
    await settle();
    expect(panel.render(60).join("\n")).toContain("newer B");
    expect(panel.render(60).join("\n")).not.toContain("stale A");
    expect(tui.renderRequests).toBe(afterPreviewB);
  });

  test("keeps the selected tree row inside the viewport", async () => {
    const { panel, source } = harness(60, 5);
    const paths = Array.from({ length: 7 }, (_, index) => `file-${index}.ts`);
    const changes = new Map(paths.map(path => [path, change(path, "M")] as const));
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot({
      allFiles: paths,
      workspaceChanges: changes,
      workspaceSummary: { files: paths.length, insertions: 0, deletions: 0 },
    }));
    await settle();
    for (let index = 0; index < 6; index += 1) panel.handleInput("\x1b[B");

    const visible = panel.render(60).join("\n");
    expect(visible).toContain("> M  file-6.ts");
    expect(visible).not.toContain("file-0.ts");
  });

  test("dispose aborts refresh and preview work and is idempotent", async () => {
    const refreshing = harness();
    refreshing.panel.start();
    refreshing.panel.dispose();
    refreshing.panel.dispose();
    expect(refreshing.source.refreshCalls[0]?.signal.aborted).toBe(true);

    const previewing = harness();
    previewing.panel.start();
    previewing.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    previewing.panel.handleInput("\x1b[B");
    const pending = previewing.source.previewCalls.at(-1);
    previewing.panel.dispose();
    previewing.panel.dispose();
    expect(pending?.signal.aborted).toBe(true);
    const requests = previewing.tui.renderRequests;
    pending?.value.resolve(preview("src/a.ts", "text", ["too late"]));
    await settle();
    expect(previewing.tui.renderRequests).toBe(requests);
  });
});

/** Column index of the wide-layout divider, or -1 when the row has none. */
function dividerColumn(lines: readonly string[]): number {
  return (lines[1] ?? "").indexOf("│", 1);
}

describe("FilesPanel focus and tree width", () => {
  test("Tab and Shift+Tab switch focus between the tree and the preview", async () => {
    const { panel, source } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["alpha"]));
    await settle();

    panel.handleInput("\t");
    expect(panel.render(60)[0]).toContain("File: src/a.ts");
    panel.handleInput("\x1b[Z");
    expect(panel.render(60)[0]).toContain("Project [modified · workspace]");
    panel.handleInput("\x1b[Z");
    expect(panel.render(60)[0]).toContain("File: src/a.ts");
    panel.handleInput("\t");
    expect(panel.render(60)[0]).toContain("Project [modified · workspace]");
  });

  test("[ and ] resize the tree pane between the minimum and the 30% cap", async () => {
    const { panel, source, tui } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    // 100 columns leave 97 interior columns; the cap is floor(97 * 0.3) = 29.
    expect(dividerColumn(panel.render(100))).toBe(30);
    const atCap = tui.renderRequests;
    panel.handleInput("]");
    expect(dividerColumn(panel.render(100))).toBe(30);
    expect(tui.renderRequests).toBe(atCap);

    panel.handleInput("[");
    expect(dividerColumn(panel.render(100))).toBe(29);
    panel.handleInput("\x1b[1;5D");
    expect(dividerColumn(panel.render(100))).toBe(28);
    panel.handleInput("\x1b[1;5C");
    expect(dividerColumn(panel.render(100))).toBe(29);

    for (let press = 0; press < 40; press += 1) panel.handleInput("[");
    expect(dividerColumn(panel.render(100))).toBe(13);
    for (let press = 0; press < 40; press += 1) panel.handleInput("]");
    expect(dividerColumn(panel.render(100))).toBe(30);
  });

  test("the width ratio survives a terminal width change", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.render(100);
    for (let press = 0; press < 9; press += 1) panel.handleInput("[");
    // 20 of 97 interior columns ≈ 20.6% of the 137 interior columns at width 140.
    expect(dividerColumn(panel.render(100))).toBe(21);
    expect(dividerColumn(panel.render(140))).toBe(29);
  });

  test("dragging the divider resizes the tree pane and stops on release", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.render(100);

    panel.handleInput("\x1b[<0;31;3M");
    panel.handleInput("\x1b[<32;21;3M");
    expect(dividerColumn(panel.render(100))).toBe(20);
    panel.handleInput("\x1b[<32;91;3M");
    expect(dividerColumn(panel.render(100))).toBe(30);
    panel.handleInput("\x1b[<32;3;3M");
    expect(dividerColumn(panel.render(100))).toBe(13);

    panel.handleInput("\x1b[<0;13;3m");
    panel.handleInput("\x1b[<32;61;3M");
    expect(dividerColumn(panel.render(100))).toBe(13);
  });

  test("a press away from the divider never starts a drag", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.render(100);

    panel.handleInput("\x1b[<0;10;3M");
    panel.handleInput("\x1b[<32;61;3M");
    expect(dividerColumn(panel.render(100))).toBe(30);
  });

  test("the wheel moves the tree selection and scrolls the preview", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.render(100);

    panel.handleInput("\x1b[<65;5;3M");
    expect(source.previewCalls.at(-1)?.path).toBe("src/b.ts");
    source.previewCalls.at(-1)?.value.resolve(preview("src/b.ts", "text", Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)));
    await settle();
    expect(panel.render(100).join("\n")).toContain(">   A  b.ts");

    panel.handleInput("\x1b[<65;60;3M");
    expect(panel.render(100)[1]).toContain(" 4 line 4");
    panel.handleInput("\x1b[<64;60;3M");
    expect(panel.render(100)[1]).toContain(" 1 line 1");

    panel.handleInput("\x1b[<64;5;3M");
    expect(panel.render(100).join("\n")).toContain("> ▼ src/");
  });

  test("opens at the restored width and reports every change once", async () => {
    const { panel, source, ratios } = harness(100, 6, { treeRatio: 0.15 });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    // 15% of the 97 interior columns is 15 columns, so the divider sits at 16.
    expect(dividerColumn(panel.render(100))).toBe(16);
    expect(ratios).toEqual([]);

    panel.handleInput("]");
    panel.handleInput("]");
    expect(ratios).toEqual([16 / 97, 17 / 97]);
    expect(dividerColumn(panel.render(100))).toBe(18);

    for (let press = 0; press < 40; press += 1) panel.handleInput("]");
    // Reports stop at the cap instead of repeating the unchanged ratio.
    expect(ratios.at(-1)).toBe(29 / 97);
    expect(ratios).toHaveLength(14);
  });

  test("clamps a restored width that is out of range", async () => {
    const wide = harness(100, 6, { treeRatio: 0.9 });
    wide.panel.start();
    wide.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    expect(dividerColumn(wide.panel.render(100))).toBe(30);

    // 5% of 97 columns is below the 12-column floor, which wins.
    const narrow = harness(100, 6, { treeRatio: -1 });
    narrow.panel.start();
    narrow.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    expect(dividerColumn(narrow.panel.render(100))).toBe(13);
  });
});

describe("FilesPanel syntax highlighting", () => {
  test("colors text previews through the injected highlighter", async () => {
    const calls: Array<readonly [string, string]> = [];
    const highlight = (code: string, path: string): readonly string[] => {
      calls.push([code, path]);
      return code.split("\n").map(line => `\x1b[35m${line}\x1b[39m`);
    };
    const { panel, source } = harness(60, 6, { highlight });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["const x = 1;", "export {};"]));
    await settle();
    panel.handleInput("\r");

    const rendered = panel.render(60);
    expect(calls).toEqual([["const x = 1;\nexport {};", "src/a.ts"]]);
    expect(rendered[1]).toBe(`│1 \x1b[35mconst x = 1;\x1b[39m${" ".repeat(44)}\x1b[0m│`);
    expect(rendered[2]).toBe(`│2 \x1b[35mexport {};\x1b[39m${" ".repeat(46)}\x1b[0m│`);
    expectWidthSafe(rendered, 60);

    // Highlighting a preview is memoized, not repeated per render.
    panel.render(60);
    expect(calls).toHaveLength(1);
  });

  test("falls back to plain lines for diffs, unknown languages, and bad results", async () => {
    const highlight = (code: string, path: string): readonly string[] | undefined =>
      path.endsWith(".ts") ? [`\x1b[35m${code}\x1b[39m`] : undefined;
    const { panel, source } = harness(60, 6, { highlight });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    // Two source lines against one highlighted line: the result is discarded.
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["alpha", "beta"]));
    await settle();
    panel.handleInput("\r");
    expect(panel.render(60)[1]).toBe(`│${"1 alpha".padEnd(58)}│`);

    panel.handleInput("\x1b");
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/b.ts", "diff", ["+added"]));
    await settle();
    panel.handleInput("\r");
    expect(panel.render(60)[1]).toBe(`│${"+added".padEnd(58)}│`);
  });

  test("sanitizes preview content before it reaches the highlighter", async () => {
    const seen: string[] = [];
    const highlight = (code: string): readonly string[] => {
      seen.push(code);
      return code.split("\n");
    };
    const { panel, source } = harness(60, 6, { highlight });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["let x = 1;\x1b[2J\x07"]));
    await settle();
    panel.handleInput("\r");

    const rendered = panel.render(60);
    expect(seen).toEqual(["let x = 1;"]);
    expect(rendered.join("\n")).not.toContain("\x1b[2J");
    expect(rendered.join("\n")).not.toContain("\x07");
  });
});

describe("FilesPanel deterministic rendering", () => {
  test("renders exact wide, narrow tree, and narrow preview arrays", async () => {
    const wide = harness(100, 6);
    wide.panel.start();
    wide.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    wide.panel.handleInput("\x1b[B");
    wide.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "diff", ["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"]));
    await settle();
    const wideLines = wide.panel.render(100);
    expect(wideLines).toEqual([
      `┌─ Project [modified · workspa┬─ Diff: src/a.ts ${"─".repeat(51)}┐`,
      `│${"  ▼ src/".padEnd(29)}│${"diff --git a/src/a.ts b/src/a.ts".padEnd(68)}│`,
      `│${">   M  a.ts".padEnd(29)}│${"@@ -1 +1 @@".padEnd(68)}│`,
      `│${"    A  b.ts".padEnd(29)}│${"-old".padEnd(68)}│`,
      `│${"".padEnd(29)}│${"+new".padEnd(68)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · ↑↓ move · ↵ open · tab · [ ] width · m/a · s · r┘",
    ]);

    const narrow = harness(60, 6);
    narrow.panel.start();
    narrow.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    const tree = narrow.panel.render(60);
    expect(tree).toEqual([
      `┌─ Project [modified · workspace] ${"─".repeat(25)}┐`,
      `│${"> ▼ src/".padEnd(58)}│`,
      `│${"    M  a.ts".padEnd(58)}│`,
      `│${"    A  b.ts".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · ↑↓ move ┘",
    ]);
    narrow.panel.handleInput("\x1b[B");
    narrow.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["alpha", "猫"]));
    await settle();
    narrow.panel.handleInput("\r");
    const file = narrow.panel.render(60);
    expect(file).toEqual([
      `┌─ File: src/a.ts ${"─".repeat(41)}┐`,
      `│${"1 alpha".padEnd(58)}│`,
      `│2 猫${" ".repeat(54)}│`,
      `│${"".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · ↑↓ scrol┘",
    ]);
    for (const lines of [wideLines, tree, file]) expectWidthSafe(lines, lines === wideLines ? 100 : 60);
    for (let width = 1; width <= 120; width += 1) {
      expectWidthSafe(narrow.panel.render(width), width);
    }
  });

  test("renders exact loading, empty, binary, truncated, and error states", async () => {
    const value = harness(60, 4);
    value.panel.start();
    const loading = value.panel.render(60);
    expect(loading).toEqual([
      `┌─ Project [modified · workspace] ${"─".repeat(25)}┐`,
      `│${"Loading project files…".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +0 -0 · 0 files · refreshi┘",
    ]);
    value.source.refreshCalls[0]?.value.resolve(snapshot({ allFiles: [], workspaceChanges: new Map(), sessionChanges: new Map(), workspaceSummary: { files: 0, insertions: 0, deletions: 0 }, sessionSummary: { files: 0, insertions: 0, deletions: 0 } }));
    await settle();
    expect(value.panel.render(60)).toEqual([
      `┌─ Project [modified · workspace] ${"─".repeat(25)}┐`,
      `│${"No workspace changes — press a for all files".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +0 -0 · 0 files · ↑↓ move ┘",
    ]);

    const special = harness(60, 5);
    special.panel.start();
    special.source.refreshCalls[0]?.value.resolve(snapshot({ truncated: true }));
    await settle();
    special.panel.handleInput("\x1b[B");
    special.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "binary", [], { byteSize: 2048 }));
    await settle();
    special.panel.handleInput("\r");
    const binary = special.panel.render(60);
    expect(binary).toEqual([
      `┌─ Binary: src/a.ts ${"─".repeat(39)}┐`,
      `│${"Binary file".padEnd(58)}│`,
      `│${"2,048 bytes".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ listing truncated · demo · modified · workspace · +3 -1 ┘",
    ]);
    special.panel.handleInput("\x1b");
    special.panel.handleInput("\x1b[B");
    special.source.previewCalls.at(-1)?.value.resolve(preview("src/b.ts", "text", ["partial"], { truncated: true }));
    await settle();
    special.panel.handleInput("\r");
    const truncated = special.panel.render(60);
    expect(truncated).toEqual([
      `┌─ File: src/b.ts ${"─".repeat(41)}┐`,
      `│${"1 partial".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ preview truncated · demo · modified · workspace · +3 -1 ┘",
    ]);
    special.panel.handleInput("\x1b");
    special.panel.handleInput("\x1b[A");
    special.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "error", [], { error: "permission denied\x1b[2J" }));
    await settle();
    special.panel.handleInput("\r");
    const error = special.panel.render(60);
    expect(error[0]).toBe(`┌─ Error: src/a.ts ${"─".repeat(40)}┐`);
    expect(error[1]).toBe(`│${"Error: permission denied".padEnd(58)}│`);
    expect(error.join("\n")).not.toContain("\x1b[2J");
    for (const lines of [loading, binary, truncated, error]) expectWidthSafe(lines, 60);
  });

  test("never exceeds zero, one, or two available terminal rows", () => {
    const { panel, tui } = harness(60, 0);
    panel.start();

    expect(panel.render(60)).toEqual([]);
    tui.setRows(1);
    const oneRow = panel.render(60);
    expect(oneRow).toEqual([
      `┌─ Project [modified · workspace] ${"─".repeat(25)}┐`,
    ]);
    tui.setRows(2);
    const twoRows = panel.render(60);
    expect(twoRows).toEqual([
      `┌─ Project [modified · workspace] ${"─".repeat(25)}┐`,
      "└─ demo · modified · workspace · +0 -0 · 0 files · refreshi┘",
    ]);
    expectWidthSafe(oneRow, 60);
    expectWidthSafe(twoRows, 60);
  });

  test("reuses rendered arrays until state, size, or invalidation changes", async () => {
    const { panel, source, tui } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    const first = panel.render(60);
    expect(panel.render(60)).toBe(first);
    expect(panel.render(61)).not.toBe(first);
    const at61 = panel.render(61);
    tui.setRows(7);
    expect(panel.render(61)).not.toBe(at61);
    const resized = panel.render(61);
    panel.invalidate();
    expect(panel.render(61)).not.toBe(resized);
  });
});
