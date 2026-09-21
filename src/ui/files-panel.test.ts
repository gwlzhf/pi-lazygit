import { describe, expect, test, vi } from "bun:test";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type {
  ChangeRecord,
  FilePreview,
  GitBranchSnapshot,
  PreviewOptions,
  ProjectSnapshot,
  ReviewSource,
  StatusCode,
  SwitchBranchOptions,
} from "../contracts";
import { FilesPanel, type FilesPanelOptions } from "./files-panel";
import type { HighlightThemeName } from "./highlight";

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

interface GitLogEntry {
  readonly oid: string;
  readonly shortOid: string;
  readonly subject: string;
  readonly author: string;
  readonly authoredAt: number;
}

interface GitLogSnapshot {
  readonly entries: readonly GitLogEntry[];
  readonly truncated: boolean;
}

interface CommitDiffPreview {
  readonly oid: string;
  readonly kind: "diff" | "error";
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

interface WatchCall {
  readonly signal: AbortSignal;
  readonly onChange: () => void;
  readonly onError: (error: unknown) => void;
}


class ControlledSource implements ReviewSource {
  readonly refreshCalls: Pending<ProjectSnapshot>[] = [];
  readonly previewCalls: (Pending<FilePreview> & {
    readonly path: string;
    readonly diffContext: number | undefined;
  })[] = [];
  readonly historyCalls: Pending<GitLogSnapshot>[] = [];
  readonly commitDiffCalls: (Pending<CommitDiffPreview> & {
    readonly oid: string;
    readonly diffContext: number | undefined;
  })[] = [];
  readonly branchesCalls: Pending<GitBranchSnapshot>[] = [];
  readonly switchCalls: (Pending<void> & { readonly name: string })[] = [];
  readonly watchCalls: WatchCall[] = [];

  refresh({ signal }: { readonly signal: AbortSignal }): Promise<ProjectSnapshot> {
    const value = deferred<ProjectSnapshot>();
    this.refreshCalls.push({ signal, value });
    return value.promise;
  }

  preview(path: string, options: PreviewOptions): Promise<FilePreview> {
    const value = deferred<FilePreview>();
    this.previewCalls.push({
      path,
      signal: options.signal,
      diffContext: options.diffContext,
      value,
    });
    return value.promise;
  }

  history({ signal }: { readonly signal: AbortSignal }): Promise<GitLogSnapshot> {
    const value = deferred<GitLogSnapshot>();
    this.historyCalls.push({ signal, value });
    return value.promise;
  }

  commitDiff(oid: string, options: PreviewOptions): Promise<CommitDiffPreview> {
    const value = deferred<CommitDiffPreview>();
    this.commitDiffCalls.push({
      oid,
      signal: options.signal,
      diffContext: options.diffContext,
      value,
    });
    return value.promise;
  }

  branches({ signal }: { readonly signal: AbortSignal }): Promise<GitBranchSnapshot> {
    const value = deferred<GitBranchSnapshot>();
    this.branchesCalls.push({ signal, value });
    return value.promise;
  }

  switchBranch(name: string, { signal }: SwitchBranchOptions): Promise<void> {
    const value = deferred<void>();
    this.switchCalls.push({ name, signal, value });
    return value.promise;
  }

  watch(options: WatchCall): Promise<void> {
    this.watchCalls.push(options);
    return Promise.resolve();
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
    currentBranch: "main",
    allFiles: ["src/a.ts", "src/b.ts", "README.md"],
    workspaceChanges: new Map([
      ["src/a.ts", change("src/a.ts", "M")],
      ["src/b.ts", change("src/b.ts", "A")],
    ]),
    sessionChanges: new Map([["src/b.ts", change("src/b.ts", "A")]]),
    workspaceSummary: { files: 2, insertions: 3, deletions: 1 },
    workspaceSummaryByPath: new Map([
      ["src/a.ts", { insertions: 1, deletions: 1 }],
      ["src/b.ts", { insertions: 1, deletions: 0 }],
    ]),
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
    bg(_color: string, text: string): string {
      return text;
    },
    fgOnBg(_color: ThemeColor, _background: string, text: string): string {
      return text;
    },
    bold(text: string): string {
      return text;
    },
  } as unknown as Theme;
}

interface FakeTui extends TUI {
  renderRequests: number;
  writes: string[];
  setRows(rows: number): void;
}

function fakeTui(columns = 100, rows = 7): FakeTui {
  const writes: string[] = [];
  const value = {
    terminal: {
      columns,
      rows,
      write(data: string): void {
        writes.push(data);
      },
    },
    writes,
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
    expect(initial[1]).toBe(`┌─ Files [modified · workspace] ${"─".repeat(27)}┐`);
    expect(initial.join("\n")).toContain("M  a.ts");
    expect(initial.join("\n")).toContain("A  b.ts");
    expect(initial.join("\n")).not.toContain("README.md");

    panel.handleInput("a");
    expect(panel.render(60).join("\n")).toContain("README.md");

    panel.handleInput("s");
    const allSession = panel.render(60).join("\n");
    expect(allSession).toContain("Files [all · session]");
    expect(allSession).toContain("   a.ts");
    expect(allSession).toContain("A  b.ts");
    expect(allSession).toContain("README.md");

    panel.handleInput("m");
    const modifiedSession = panel.render(60).join("\n");
    expect(modifiedSession).toContain("Files [modified · session]");
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
    expect(rendered[1]).toContain("Files [filesystem]");
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
    panel.handleInput("n");
    expect(source.previewCalls.at(-1)?.path).toBe("src/b.ts");
    expect(source.previewCalls.at(-2)?.signal.aborted).toBe(true);
    panel.handleInput("p");
    expect(source.previewCalls.at(-1)?.path).toBe("src/a.ts");
    panel.handleInput("\x1b[A");
    expect(panel.render(60).join("\n")).toContain("> ▼ src/");
  });

  test("Enter on a file focuses preview and scrolling clamps", async () => {
    const { panel, source } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)));
    await settle();
    panel.handleInput("\r");
    expect(panel.render(60)).toEqual([
      "Diff working tree                             main · 2 files",
      `┌─ src/a.ts · +1 -1 ${"─".repeat(39)}┐`,
      `│${" 1 line 1".padEnd(58)}│`,
      `│${" 2 line 2".padEnd(58)}│`,
      `│${" 3 line 3".padEnd(58)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · F5/r ref┘",
    ]);
    panel.handleInput("\x1b[F");
    panel.handleInput("\x1b[B");
    expect(panel.render(60).slice(2, 5)).toEqual([
      `│${" 8 line 8".padEnd(58)}│`,
      `│${" 9 line 9".padEnd(58)}│`,
      `│${"10 line 10".padEnd(58)}│`,
    ]);
    panel.handleInput("\x1b[H");
    panel.handleInput("\x1b[A");
    expect(panel.render(60)[2]).toBe(`│${" 1 line 1".padEnd(58)}│`);
    panel.handleInput("\x1b[6~");
    expect(panel.render(60)[2]).toBe(`│${" 4 line 4".padEnd(58)}│`);
    panel.handleInput("\x1b[5~");
    expect(panel.render(60)[2]).toBe(`│${" 1 line 1".padEnd(58)}│`);
  });

  test("Esc returns to tree before closing and done is idempotent", async () => {
    const { panel, source, doneResults } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    panel.handleInput("\x1b");
    expect(panel.render(60)[1]).toContain("Files");
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

  test("F5 refreshes the change list and selected code from the preview", async () => {
    const { panel, source } = harness(100, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["before refresh"]));
    await settle();
    panel.handleInput("\r");

    panel.handleInput("\x1b[15~");
    expect(panel.render(100).join("\n")).toContain("before refresh");
    source.refreshCalls[1]?.value.resolve(snapshot({
      allFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "README.md"],
      workspaceChanges: new Map([
        ["src/a.ts", change("src/a.ts", "M")],
        ["src/b.ts", change("src/b.ts", "A")],
        ["src/c.ts", change("src/c.ts", "M")],
      ]),
      workspaceSummary: { files: 3, insertions: 5, deletions: 2 },
    }));
    await settle();
    expect(source.previewCalls.at(-1)?.path).toBe("src/a.ts");
    expect(panel.render(100).join("\n")).toContain("c.ts");
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

  test("manual refresh queues behind the active snapshot and late previews cannot replace newer results", async () => {
    const { panel, source, tui } = harness(60, 6);
    panel.start();
    const refreshA = source.refreshCalls[0];
    panel.handleInput("r");
    expect(source.refreshCalls).toHaveLength(1);
    expect(refreshA?.signal.aborted).toBe(false);
    refreshA?.value.resolve(snapshot());
    await settle();
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

  test("installs a watcher only after resolving a Git snapshot", async () => {
    const git = harness();
    git.panel.start();
    git.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    expect(git.source.watchCalls).toHaveLength(1);

    const filesystem = harness();
    filesystem.panel.start();
    filesystem.source.refreshCalls[0]?.value.resolve(snapshot({ kind: "filesystem", hasHead: false }));
    await settle();
    expect(filesystem.source.watchCalls).toHaveLength(0);

    git.panel.dispose();
    filesystem.panel.dispose();
  });

  test("debounces watcher invalidations for 150ms", async () => {
    vi.useFakeTimers();
    const { panel, source } = harness();
    try {
      panel.start();
      source.refreshCalls[0]?.value.resolve(snapshot());
      await settle();
      expect(source.watchCalls).toHaveLength(1);

      const watch = source.watchCalls[0];
      watch?.onChange();
      for (let index = 0; index < 9; index += 1) watch?.onChange();
      vi.advanceTimersByTime(149);
      expect(source.refreshCalls).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(source.refreshCalls).toHaveLength(2);
    } finally {
      panel.dispose();
      vi.useRealTimers();
    }
  });

  test("coalesces watcher invalidations while a refresh is running", async () => {
    vi.useFakeTimers();
    const { panel, source } = harness();
    try {
      panel.start();
      source.refreshCalls[0]?.value.resolve(snapshot());
      await settle();
      expect(source.watchCalls).toHaveLength(1);

      const watch = source.watchCalls[0];
      watch?.onChange();
      vi.advanceTimersByTime(150);
      const running = source.refreshCalls[1];
      expect(source.refreshCalls).toHaveLength(2);
      expect(running?.signal.aborted).toBe(false);

      watch?.onChange();
      watch?.onChange();
      watch?.onChange();
      vi.advanceTimersByTime(150);
      expect(source.refreshCalls).toHaveLength(2);
      expect(running?.signal.aborted).toBe(false);

      running?.value.resolve(snapshot());
      await settle();
      vi.advanceTimersByTime(150);
      expect(source.refreshCalls).toHaveLength(3);
    } finally {
      panel.dispose();
      vi.useRealTimers();
    }
  });

  test("watch errors preserve the preview and leave manual refresh available", async () => {
    const { panel, source } = harness(100, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["stable preview"]));
    await settle();
    expect(source.watchCalls).toHaveLength(1);

    source.watchCalls[0]?.onError(new Error("\x1b[31mwatch failed\x1b[0m"));
    await settle();
    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("stable preview");
    expect(rendered).toContain("watch error: watch failed");

    panel.handleInput("r");
    expect(source.refreshCalls).toHaveLength(2);

    panel.dispose();
  });

  test("log selection aborts the old request and displays the selected commit diff", async () => {
    const { panel, source } = harness(100, 7);
    const first: GitLogEntry = {
      oid: "a".repeat(40),
      shortOid: "aaaaaaaa",
      subject: "first commit",
      author: "Pi Files Test",
      authoredAt: 1,
    };
    const second: GitLogEntry = {
      oid: "b".repeat(40),
      shortOid: "bbbbbbbb",
      subject: "second commit",
      author: "Pi Files Test",
      authoredAt: 2,
    };
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    panel.handleInput("g");
    expect(source.historyCalls).toHaveLength(1);
    source.historyCalls[0]?.value.resolve({ entries: [first, second], truncated: false });
    await settle();
    expect(source.commitDiffCalls[0]?.oid).toBe(first.oid);

    panel.handleInput("\x1b[B");
    expect(source.commitDiffCalls[0]?.signal.aborted).toBe(true);
    expect(source.commitDiffCalls[1]?.oid).toBe(second.oid);
    source.commitDiffCalls[1]?.value.resolve({
      oid: second.oid,
      kind: "diff",
      lines: ["+second commit diff"],
      truncated: false,
    });
    await settle();

    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain(second.shortOid);
    expect(rendered).toContain(second.subject);
    expect(rendered).toContain("+second commit diff");
    expect(rendered).not.toContain("first commit diff");
  });
  test("dispose aborts watcher, refresh, history, preview, and commit-diff work idempotently", async () => {
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
    const pendingPreview = previewing.source.previewCalls.at(-1);
    previewing.panel.dispose();
    previewing.panel.dispose();
    expect(pendingPreview?.signal.aborted).toBe(true);
    const requests = previewing.tui.renderRequests;
    pendingPreview?.value.resolve(preview("src/a.ts", "text", ["too late"]));
    await settle();
    expect(previewing.tui.renderRequests).toBe(requests);

    const loadingHistory = harness();
    loadingHistory.panel.start();
    loadingHistory.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    loadingHistory.panel.handleInput("g");
    const pendingHistory = loadingHistory.source.historyCalls[0];
    loadingHistory.panel.dispose();
    expect(pendingHistory?.signal.aborted).toBe(true);

    const logging = harness();
    logging.panel.start();
    logging.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    logging.panel.handleInput("g");
    logging.source.historyCalls[0]?.value.resolve({
      entries: [{
        oid: "a".repeat(40),
        shortOid: "aaaaaaaa",
        subject: "first commit",
        author: "Pi Files Test",
        authoredAt: 1,
      }],
      truncated: false,
    });
    await settle();
    const pendingCommit = logging.source.commitDiffCalls[0];
    const watch = logging.source.watchCalls[0];
    logging.panel.dispose();
    logging.panel.dispose();
    expect(watch?.signal.aborted).toBe(true);
    expect(pendingCommit?.signal.aborted).toBe(true);
  });
});

/** Column index of the wide-layout divider, or -1 when the row has none. */
function dividerColumn(lines: readonly string[]): number {
  return (lines[2] ?? "").indexOf("│", 1);
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
    expect(panel.render(60)[1]).toContain("src/a.ts · +1 -1");
    panel.handleInput("\x1b[Z");
    expect(panel.render(60)[1]).toContain("Files [modified · workspace]");
    panel.handleInput("\x1b[Z");
    expect(panel.render(60)[1]).toContain("src/a.ts · +1 -1");
    panel.handleInput("\t");
    expect(panel.render(60)[1]).toContain("Files [modified · workspace]");
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

  test("[ and ] are ignored in the single-pane layout instead of rewriting the stored width", async () => {
    // Below 80 columns the panel shows one pane and never consults the tree
    // width, so a resize there would only change the pane behind the user's
    // back the next time the terminal is wide enough to show both panes.
    const { panel, source, tui, ratios } = harness(70, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    // Column 69 is the closing border of a 70-column row: no interior divider.
    expect(dividerColumn(panel.render(70))).toBe(69);

    const atNarrow = tui.renderRequests;
    for (let press = 0; press < 5; press += 1) panel.handleInput("[");
    panel.handleInput("]");
    panel.handleInput("\x1b[1;5D");
    panel.handleInput("\x1b[1;5C");
    expect(ratios).toEqual([]);
    expect(tui.renderRequests).toBe(atNarrow);

    // Widening the terminal still opens at the untouched default cap.
    expect(dividerColumn(panel.render(100))).toBe(30);
  });

  test("the footer advertises [ ] width only where a divider exists", async () => {
    // Wide enough that the footer is not clipped before the width hint.
    const { panel, source } = harness(200, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    expect(panel.render(200).at(-1)).toContain("[ ] width");
    expect(panel.render(70).at(-1)).not.toContain("[ ] width");
    // A collapsed tree is single-pane too, however wide the terminal is.
    panel.render(200);
    panel.handleInput("\\");
    expect(panel.render(200).at(-1)).not.toContain("[ ] width");
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
    expect(panel.render(100)[2]).toContain(" 4 line 4");
    panel.handleInput("\x1b[<64;60;3M");
    expect(panel.render(100)[2]).toContain(" 1 line 1");

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

  test("Right and l cross into the preview from a file and expand a directory", async () => {
    const { panel, source } = harness(60, 6);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    // The selection starts on the src/ directory, where Right still collapses
    // and expands instead of switching panes.
    panel.handleInput("\x1b[D");
    expect(panel.render(60).join("\n")).not.toContain("a.ts");
    panel.handleInput("\x1b[C");
    expect(panel.render(60).join("\n")).toContain("M  a.ts");
    expect(panel.render(60)[1]).toContain("Files [modified · workspace]");

    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["alpha"]));
    await settle();
    panel.handleInput("\x1b[C");
    expect(panel.render(60)[1]).toContain("src/a.ts");

    panel.handleInput("\x1b[D");
    expect(panel.render(60)[1]).toContain("Files [modified · workspace]");
    panel.handleInput("l");
    expect(panel.render(60)[1]).toContain("src/a.ts");
    panel.handleInput("h");
    expect(panel.render(60)[1]).toContain("Files [modified · workspace]");
  });
});

describe("FilesPanel preview selection", () => {
  async function previewHarness(lines: readonly string[]): Promise<ReturnType<typeof harness>> {
    const value = harness(100, 6);
    value.panel.start();
    value.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    value.panel.render(100);
    value.panel.handleInput("\x1b[B");
    value.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", lines));
    await settle();
    value.panel.render(100);
    return value;
  }

  // The preview pane of a 100-column panel starts at 0-based column 31, so an
  // SGR column field of 32 is its first column; row field 2 is its first row.
  test("dragging over the preview copies the selected text with OSC 52", async () => {
    const { panel, tui } = await previewHarness(["alpha", "bravo"]);

    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<32;38;3M");
    expect(panel.render(100)[2]).toContain("1 \x1b[7malpha\x1b[27m");
    expect(tui.writes).toEqual([]);

    panel.handleInput("\x1b[<0;38;3m");
    expect(tui.writes).toEqual([`\x1b]52;c;${Buffer.from("alpha", "utf8").toString("base64")}\x07`]);
    expect(panel.render(100).at(-1)).toContain("copied 1 line");
  });

  test("a drag across rows copies every selected row", async () => {
    const { panel, tui } = await previewHarness(["alpha", "bravo"]);

    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<32;38;4M");
    panel.handleInput("\x1b[<0;38;4m");
    expect(tui.writes).toEqual([
      `\x1b]52;c;${Buffer.from("alpha\n2 bravo", "utf8").toString("base64")}\x07`,
    ]);
    expect(panel.render(100).at(-1)).toContain("copied 2 lines");
  });

  test("a press without a drag focuses the preview without copying", async () => {
    const { panel, tui } = await previewHarness(
      Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
    );

    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<0;34;3m");
    expect(tui.writes).toEqual([]);
    // Focus moved with the press, so Down scrolls the preview instead of
    // moving the tree selection.
    panel.handleInput("\x1b[B");
    expect(panel.render(100)[2]).toContain(" 2 line 2");
  });

  test("scrolling retires the selection and its footer notice", async () => {
    const { panel } = await previewHarness(
      Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
    );

    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<32;38;3M");
    panel.handleInput("\x1b[<0;38;3m");
    expect(panel.render(100).at(-1)).toContain("copied 1 line");

    panel.handleInput("\x1b[<65;60;4M");
    const scrolled = panel.render(100);
    expect(scrolled.at(-1)).not.toContain("copied");
    expect(scrolled.join("\n")).not.toContain("\x1b[7m");
  });

  test("automatic watch refresh retires stale preview selection", async () => {
    vi.useFakeTimers();
    try {
      const { panel, source } = await previewHarness(["alpha", "bravo"]);
      panel.handleInput("\x1b[<0;34;3M");
      panel.handleInput("\x1b[<32;38;3M");
      panel.handleInput("\x1b[<0;38;3m");
      expect(panel.render(100).at(-1)).toContain("copied 1 line");

      source.watchCalls[0]?.onChange();
      vi.advanceTimersByTime(150);
      source.refreshCalls[1]?.value.resolve(snapshot());
      await settle();
      expect(panel.render(100).at(-1)).not.toContain("copied");
    } finally {
      vi.useRealTimers();
    }
  });

  test("tree resize retires stale preview selection", async () => {
    const { panel } = await previewHarness(["alpha", "bravo"]);
    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<32;38;3M");
    panel.handleInput("\x1b[<0;38;3m");
    expect(panel.render(100).at(-1)).toContain("copied 1 line");

    panel.handleInput("[");
    expect(panel.render(100).at(-1)).not.toContain("copied");
  });

  test("terminal width and height changes retire stale preview selection", async () => {
    const { panel, tui } = await previewHarness(["alpha", "bravo"]);
    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<32;38;3M");
    panel.handleInput("\x1b[<0;38;3m");
    expect(panel.render(100).at(-1)).toContain("copied 1 line");

    panel.render(90);
    expect(panel.render(90).at(-1)).not.toContain("copied");

    panel.render(100);
    panel.handleInput("\x1b[<0;34;3M");
    panel.handleInput("\x1b[<32;38;3M");
    panel.handleInput("\x1b[<0;38;3m");
    expect(panel.render(100).at(-1)).toContain("copied 1 line");
    tui.setRows(7);
    expect(panel.render(100).at(-1)).not.toContain("copied");
  });

  test("a press on the divider drags the width instead of selecting text", async () => {
    const { panel, tui } = await previewHarness(["alpha", "bravo"]);

    panel.handleInput("\x1b[<0;31;3M");
    panel.handleInput("\x1b[<32;21;3M");
    panel.handleInput("\x1b[<0;21;3m");
    expect(dividerColumn(panel.render(100))).toBe(20);
    expect(tui.writes).toEqual([]);
  });
});

describe("FilesPanel syntax highlighting", () => {
  test("colors text previews with the active Pi theme by default", async () => {
    const piTheme = plainTheme();
    const calls: Array<readonly [string, string, HighlightThemeName, Theme]> = [];
    const highlight = (code: string, path: string, theme: HighlightThemeName, activeTheme: Theme): readonly string[] => {
      calls.push([code, path, theme, activeTheme]);
      return code.split("\n").map(line => `\x1b[35m${line}\x1b[39m`);
    };
    const { panel, source } = harness(60, 6, { highlight, theme: piTheme });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["const x = 1;", "export {};"]));
    await settle();
    panel.handleInput("\r");

    const rendered = panel.render(60);
    expect(calls).toEqual([["const x = 1;\nexport {};", "src/a.ts", "pi", piTheme]]);
    expect(rendered[2]).toBe(`│1 \x1b[35mconst x = 1;\x1b[39m${" ".repeat(44)}\x1b[0m│`);
    expect(rendered[3]).toBe(`│2 \x1b[35mexport {};\x1b[39m${" ".repeat(46)}\x1b[0m│`);
    expectWidthSafe(rendered, 60);

    // Highlighting a preview is memoized, not repeated per render.
    panel.render(60);
    expect(calls).toHaveLength(1);
  });

  test("highlights only the visible prefix and extends it incrementally while scrolling", async () => {
    const fallbackCalls: string[] = [];
    const pushedChunks: string[] = [];
    const highlight = Object.assign(
      (code: string): readonly string[] => {
        fallbackCalls.push(code);
        return code.split("\n");
      },
      {
        createStream: () => ({
          push(chunk: string): string {
            pushedChunks.push(chunk);
            return chunk;
          },
        }),
      },
    );
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    const { panel, source } = harness(60, 7, { highlight });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", lines));
    await settle();
    panel.handleInput("\r");

    panel.render(60);
    expect(pushedChunks).toEqual(["line 1\nline 2\nline 3\nline 4\n"]);
    expect(fallbackCalls).toEqual([]);

    panel.handleInput("j");
    panel.render(60);
    expect(pushedChunks).toEqual([
      "line 1\nline 2\nline 3\nline 4\n",
      "line 5\n",
    ]);
  });

  test("cycles themes in tree and preview focus and invalidates highlighted lines", async () => {
    const calls: HighlightThemeName[] = [];
    const changes: HighlightThemeName[] = [];
    const highlight = (
      code: string,
      _path: string,
      theme: HighlightThemeName,
    ): readonly string[] => {
      calls.push(theme);
      return code.split("\n");
    };
    const { panel, source, tui } = harness(120, 6, {
      highlight,
      onHighlightThemeChange: theme => changes.push(theme),
    });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["const x = 1;"]));
    await settle();

    expect(panel.render(120).at(-1)).toContain("theme Pi · t theme");
    expect(calls).toEqual(["pi"]);

    const beforeTreeSwitch = tui.renderRequests;
    panel.handleInput("t");
    expect(tui.renderRequests).toBe(beforeTreeSwitch + 1);
    expect(changes).toEqual(["catppuccin"]);
    expect(panel.render(120).at(-1)).toContain("theme Catppuccin · t theme");
    expect(calls).toEqual(["pi", "catppuccin"]);

    panel.handleInput("\r");
    const beforePreviewSwitch = tui.renderRequests;
    panel.handleInput("t");
    expect(tui.renderRequests).toBe(beforePreviewSwitch + 1);
    expect(changes).toEqual(["catppuccin", "nord"]);
    expect(panel.render(120).at(-1)).toContain("theme Nord · t theme");
    expect(calls).toEqual(["pi", "catppuccin", "nord"]);

    panel.handleInput("t");
    expect(changes).toEqual(["catppuccin", "nord", "tokyo-night"]);
    panel.render(120);
    expect(calls).toEqual(["pi", "catppuccin", "nord", "tokyo-night"]);

    panel.handleInput("t");
    expect(changes).toEqual(["catppuccin", "nord", "tokyo-night", "pi"]);
    panel.render(120);
    expect(calls).toEqual(["pi", "catppuccin", "nord", "tokyo-night", "pi"]);
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
    expect(panel.render(60)[2]).toBe(`│${"1 alpha".padEnd(58)}│`);

    panel.handleInput("\x1b");
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/b.ts", "diff", ["+added"]));
    await settle();
    panel.handleInput("\r");
    expect(panel.render(60)[2]).toBe(`│${"+added".padEnd(58)}│`);
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
    const wide = harness(100, 7);
    wide.panel.start();
    wide.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    wide.panel.handleInput("\x1b[B");
    wide.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "diff", ["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"]));
    await settle();
    const wideLines = wide.panel.render(100);
    expect(wideLines).toEqual([
      "Diff working tree                                                                     main · 2 files",
      "┌─ Files [modified · workspace┬─ src/a.ts · +1 -1 ─────────────────────────────────────────────────┐",
      `│${"  ▼ src/".padEnd(29)}│${"diff --git a/src/a.ts b/src/a.ts".padEnd(68)}│`,
      `│${">   M  a.ts".padEnd(29)}│${"@@ -1 +1 @@".padEnd(68)}│`,
      `│${"    A  b.ts".padEnd(29)}│${"-old".padEnd(68)}│`,
      `│${"".padEnd(29)}│${"+new".padEnd(68)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · unified diff · ctx 3 · F5/r refresh · tab focus ┘",
    ]);

    const narrow = harness(60, 7);
    narrow.panel.start();
    narrow.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    const tree = narrow.panel.render(60);
    expect(tree).toEqual([
      "Diff working tree                             main · 2 files",
      "┌─ Files [modified · workspace] ───────────────────────────┐",
      `│${"> ▼ src/".padEnd(58)}│`,
      `│${"    M  a.ts".padEnd(58)}│`,
      `│${"    A  b.ts".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · F5/r ref┘",
    ]);
    narrow.panel.handleInput("\x1b[B");
    narrow.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["alpha", "猫"]));
    await settle();
    narrow.panel.handleInput("\r");
    const file = narrow.panel.render(60);
    expect(file).toEqual([
      "Diff working tree                             main · 2 files",
      `┌─ src/a.ts · +1 -1 ${"─".repeat(39)}┐`,
      `│${"1 alpha".padEnd(58)}│`,
      `│2 猫${" ".repeat(54)}│`,
      `│${"".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +3 -1 · 2 files · F5/r ref┘",
    ]);
    for (const lines of [wideLines, tree, file]) expectWidthSafe(lines, lines === wideLines ? 100 : 60);
    for (let width = 1; width <= 120; width += 1) {
      expectWidthSafe(narrow.panel.render(width), width);
    }
  });

  test("renders exact loading, empty, binary, truncated, and error states", async () => {
    const value = harness(60, 5);
    value.panel.start();
    const loading = value.panel.render(60);
    expect(loading).toEqual([
      "Diff working tree                                    0 files",
      "┌─ Files [modified · workspace] ───────────────────────────┐",
      `│${"Loading project files…".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +0 -0 · 0 files · refreshi┘",
    ]);
    value.source.refreshCalls[0]?.value.resolve(snapshot({ allFiles: [], workspaceChanges: new Map(), sessionChanges: new Map(), workspaceSummary: { files: 0, insertions: 0, deletions: 0 }, sessionSummary: { files: 0, insertions: 0, deletions: 0 } }));
    await settle();
    expect(value.panel.render(60)).toEqual([
      "Diff working tree                             main · 0 files",
      "┌─ Files [modified · workspace] ───────────────────────────┐",
      `│${"No workspace changes — press a for all files".padEnd(58)}│`,
      `│${"".padEnd(58)}│`,
      "└─ demo · modified · workspace · +0 -0 · 0 files · F5/r ref┘",
    ]);

    const special = harness(60, 6);
    special.panel.start();
    special.source.refreshCalls[0]?.value.resolve(snapshot({ truncated: true }));
    await settle();
    special.panel.handleInput("\x1b[B");
    special.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "binary", [], { byteSize: 2048 }));
    await settle();
    special.panel.handleInput("\r");
    const binary = special.panel.render(60);
    expect(binary).toEqual([
      "Diff working tree                             main · 2 files",
      "┌─ src/a.ts · +1 -1 ───────────────────────────────────────┐",
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
      "Diff working tree                             main · 2 files",
      "┌─ src/b.ts · +1 -0 ───────────────────────────────────────┐",
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
    expect(error[1]).toBe("┌─ src/a.ts · +1 -1 ───────────────────────────────────────┐");
    expect(error[2]).toBe(`│${"Error: permission denied".padEnd(58)}│`);
    expect(error.join("\n")).not.toContain("\x1b[2J");
    for (const lines of [loading, binary, truncated, error]) expectWidthSafe(lines, 60);
  });

  test("never exceeds zero, one, two, or three available terminal rows", () => {
    const { panel, tui } = harness(60, 0);
    panel.start();

    expect(panel.render(60)).toEqual([]);
    tui.setRows(1);
    const oneRow = panel.render(60);
    expect(oneRow).toEqual([
      "Diff working tree                                    0 files",
    ]);
    tui.setRows(2);
    const twoRows = panel.render(60);
    expect(twoRows).toEqual([
      "Diff working tree                                    0 files",
      "┌─ Files [modified · workspace] ───────────────────────────┐",
    ]);
    tui.setRows(3);
    const threeRows = panel.render(60);
    expect(threeRows).toEqual([
      "Diff working tree                                    0 files",
      "┌─ Files [modified · workspace] ───────────────────────────┐",
      "└─ demo · modified · workspace · +0 -0 · 0 files · refreshi┘",
    ]);
    expectWidthSafe(oneRow, 60);
    expectWidthSafe(twoRows, 60);
    expectWidthSafe(threeRows, 60);
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

describe("FilesPanel tree collapse", () => {
  async function collapsibleHarness(overrides: Partial<FilesPanelOptions> = {}): Promise<{
    readonly value: ReturnType<typeof harness>;
    readonly collapses: boolean[];
  }> {
    const collapses: boolean[] = [];
    const value = harness(100, 7, {
      onTreeCollapsedChange: collapsed => collapses.push(collapsed),
      ...overrides,
    });
    value.panel.start();
    value.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    value.panel.handleInput("\x1b[B");
    value.source.previewCalls.at(-1)?.value.resolve(
      preview("src/a.ts", "text", ["alpha", "beta", "gamma", "delta", "epsilon"]),
    );
    await settle();
    return { value, collapses };
  }

  test("hides the tree pane, reports the change, and restores it", async () => {
    const { value, collapses } = await collapsibleHarness();
    const { panel } = value;

    expect(panel.render(100)[1]).toContain("┬");

    panel.handleInput("\\");
    const collapsed = panel.render(100);
    expect(collapses).toEqual([true]);
    expect(collapsed[1]).toBe("┌─ src/a.ts · +1 -1 ───────────────────────────────────────────────────────────────────────────────┐");
    expect(collapsed[2]).toBe(`│${"1 alpha".padEnd(98)}│`);
    expect(collapsed.at(-1)).toContain("j/k scroll");
    expectWidthSafe(collapsed, 100);

    // Ctrl+B toggles the tree as well.
    panel.handleInput("\x02");
    expect(collapses).toEqual([true, false]);
    expect(panel.render(100)[1]).toContain("┬");
  });

  test("routes keys to the preview while collapsed and reveals the tree again on tab", async () => {
    const { value, collapses } = await collapsibleHarness();
    const { panel } = value;

    panel.handleInput("\\");
    panel.handleInput("j");
    expect(panel.render(100)[2]).toBe(`│${"2 beta".padEnd(98)}│`);

    panel.handleInput("\t");
    expect(collapses).toEqual([true, false]);
    const restored = panel.render(100);
    expect(restored[1]).toContain("┬");
    // Focus is back on the tree: its selected row keeps the cursor marker.
    expect(restored[3]).toContain(">   M  a.ts");
  });

  test("escape reveals a collapsed tree before it closes the panel", async () => {
    const { value } = await collapsibleHarness();
    const { panel, doneResults } = value;

    panel.handleInput("\\");
    panel.handleInput("\x1b");
    expect(doneResults).toEqual([]);
    expect(panel.render(100)[1]).toContain("┬");

    panel.handleInput("\x1b");
    expect(doneResults).toEqual([undefined]);
  });

  test("opens collapsed when the persisted settings say so, and ] brings the tree back", async () => {
    const collapses: boolean[] = [];
    const { panel, source } = harness(100, 7, {
      treeCollapsed: true,
      onTreeCollapsedChange: collapsed => collapses.push(collapsed),
    });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    const opened = panel.render(100);
    expect(opened[1]).toBe(`┌─ Preview ${"─".repeat(88)}┐`);
    expect(opened[2]).toBe(`│${"Select a file to preview".padEnd(98)}│`);

    // Narrowing a hidden tree is a no-op; widening reveals it.
    panel.handleInput("[");
    expect(collapses).toEqual([]);
    expect(panel.render(100)[1]).toBe(`┌─ Preview ${"─".repeat(88)}┐`);
    panel.handleInput("]");
    expect(collapses).toEqual([false]);
    expect(panel.render(100)[1]).toContain("┬");
  });
});

describe("FilesPanel diff layout and context", () => {
  const DIFF_LINES = ["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"];

  async function diffHarness(columns: number, overrides: Partial<FilesPanelOptions> = {}): Promise<
    ReturnType<typeof harness>
  > {
    const value = harness(columns, 7, overrides);
    value.panel.start();
    value.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    value.panel.handleInput("\x1b[B");
    value.source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "diff", DIFF_LINES));
    await settle();
    return value;
  }

  test("d pairs removals with additions in two aligned columns", async () => {
    const layouts: string[] = [];
    const { panel } = await diffHarness(100, {
      onDiffLayoutChange: layout => layouts.push(layout),
    });

    expect(panel.render(100)[4]).toBe(`│${"    A  b.ts".padEnd(29)}│${"-old".padEnd(68)}│`);

    panel.handleInput("d");
    const split = panel.render(100);
    expect(layouts).toEqual(["split"]);
    expect(split[2]).toBe(`│${"  ▼ src/".padEnd(29)}│${DIFF_LINES[0]?.padEnd(68)}│`);
    expect(split[3]).toBe(`│${">   M  a.ts".padEnd(29)}│${"@@ -1 +1 @@".padEnd(68)}│`);
    expect(split[4]).toBe(
      `│${"    A  b.ts".padEnd(29)}│1 ${"-old".padEnd(31)}│1 ${"+new".padEnd(32)}│`,
    );
    expect(split.at(-1)).toContain("split diff · ctx 3");
    expectWidthSafe(split, 100);

    panel.handleInput("d");
    expect(layouts).toEqual(["split", "unified"]);
    expect(panel.render(100)[4]).toBe(`│${"    A  b.ts".padEnd(29)}│${"-old".padEnd(68)}│`);
  });

  test("keeps the unified layout when the preview pane is too narrow to split", async () => {
    const { panel } = await diffHarness(40, { diffLayout: "split" });

    panel.handleInput("\r");
    const rendered = panel.render(40);
    expect(rendered[2]).toBe(`│${DIFF_LINES[0]?.padEnd(38)}│`);
    expect(rendered[4]).toBe(`│${"-old".padEnd(38)}│`);
  });

  test("c cycles the Git context, refetches the preview, and reports the change", async () => {
    const contexts: number[] = [];
    const { panel, source } = await diffHarness(100, {
      onDiffContextChange: context => contexts.push(context),
    });

    expect(source.previewCalls.at(-1)?.diffContext).toBe(3);
    expect(panel.render(100).at(-1)).toContain("ctx 3");

    panel.handleInput("c");
    expect(contexts).toEqual([10]);
    const refetch = source.previewCalls.at(-1);
    expect(refetch?.path).toBe("src/a.ts");
    expect(refetch?.diffContext).toBe(10);
    refetch?.value.resolve(preview("src/a.ts", "diff", DIFF_LINES));
    await settle();
    expect(panel.render(100).at(-1)).toContain("ctx 10");

    panel.handleInput("c");
    panel.handleInput("c");
    expect(contexts).toEqual([10, 25, 100_000]);
    expect(source.previewCalls.at(-1)?.diffContext).toBe(100_000);
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "diff", DIFF_LINES));
    await settle();
    expect(panel.render(100).at(-1)).toContain("ctx full");

    panel.handleInput("c");
    expect(contexts).toEqual([10, 25, 100_000, 3]);
  });

  test("scrolls the split view by its own row count", async () => {
    const lines = ["@@ -1,4 +1,4 @@"];
    for (let index = 1; index <= 8; index += 1) lines.push(`-old ${index}`);
    for (let index = 1; index <= 8; index += 1) lines.push(`+new ${index}`);
    const { panel, source } = harness(100, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("\x1b[B");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "diff", lines));
    await settle();
    panel.handleInput("d");
    panel.handleInput("\r");

    // 1 hunk header plus 8 paired rows: the last page of 4 starts at row 5,
    // where the 16-line unified diff would still have 12 lines to go.
    panel.handleInput("\x1b[F");
    const end = panel.render(100);
    expect(end[2]).toBe(`│${"  ▼ src/".padEnd(29)}│5 ${"-old 5".padEnd(31)}│5 ${"+new 5".padEnd(32)}│`);
    expect(end[5]).toBe(`│${"".padEnd(29)}│8 ${"-old 8".padEnd(31)}│8 ${"+new 8".padEnd(32)}│`);
  });
});

describe("FilesPanel branch, key, mouse, and presentation redesign", () => {
  test("renders overview, pane titles, body, and footer with three chrome rows", async () => {
    const { panel, source } = harness(100, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    const lines = panel.render(100);
    expect(lines[0]).toContain("Diff working tree");
    expect(lines[0]).toContain("main · 2 files");
    expect(lines[1]).toContain("Files");
    expect(lines[2]).toContain("src");
    expect(lines.at(-1)).toContain("n next");
  });

  test("uses n/p for files, history, and branches while preview keeps j/k scrolling", async () => {
    const { panel, source, doneResults } = harness(100, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();

    panel.handleInput("n");
    expect(source.previewCalls.at(-1)?.path).toBe("src/a.ts");
    const fileSelection = panel.render(100).join("\n");
    panel.handleInput("j");
    expect(panel.render(100).join("\n")).toBe(fileSelection);
    panel.handleInput("p");
    expect(panel.render(100).join("\n")).toContain("> ▼ src/");

    panel.handleInput("g");
    source.historyCalls[0]?.value.resolve({
      entries: [
        { oid: "a", shortOid: "a", subject: "first", author: "test", authoredAt: 1 },
        { oid: "b", shortOid: "b", subject: "second", author: "test", authoredAt: 2 },
      ],
      truncated: false,
    });
    await settle();
    const firstHistory = panel.render(100).join("\n");
    panel.handleInput("j");
    expect(panel.render(100).join("\n")).toBe(firstHistory);
    panel.handleInput("n");
    expect(source.commitDiffCalls.at(-1)?.oid).toBe("b");

    panel.handleInput("g");
    panel.handleInput("b");
    source.branchesCalls[0]?.value.resolve({
      branches: [
        { name: "main", current: true },
        { name: "feature/ui", current: false },
      ],
      current: "main",
    });
    await settle();
    const firstBranch = panel.render(100).join("\n");
    panel.handleInput("j");
    expect(panel.render(100).join("\n")).toBe(firstBranch);
    panel.handleInput("n");
    expect(panel.render(100).join("\n")).not.toBe(firstBranch);
    panel.handleInput("\x1b");
    expect(doneResults).toEqual([]);
    expect(panel.render(100).join("\n")).toContain("Diff working tree");
    panel.handleInput("n");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "text", ["line 1", "line 2", "line 3", "line 4", "line 5"]));
    await settle();
    panel.handleInput("\x1b[C");
    panel.handleInput("j");
    expect(panel.render(100).join("\n")).toContain("2 line 2");
    panel.handleInput("k");
    expect(panel.render(100).join("\n")).toContain("1 line 1");
  });

  test("help captures escape without losing the underlying selection", async () => {
    const { panel, source, doneResults } = harness(100, 7);
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.handleInput("n");
    const beforeHelp = panel.render(100).join("\n");

    panel.handleInput("?");
    expect(panel.render(100).join("\n")).toContain("Navigation");
    panel.handleInput("\x1b");
    expect(doneResults).toEqual([]);
    expect(panel.render(100).join("\n")).toContain("src/a.ts");
    expect(panel.render(100).join("\n")).not.toContain("Navigation");
    expect(panel.render(100).join("\n")).toBe(beforeHelp);
  });

  test("clicking a scrolled tree row maps through the overview offset and starts one preview", async () => {
    const paths = Array.from({ length: 8 }, (_, index) => `file-${index}.ts`);
    const changes = new Map(paths.map(path => [path, change(path, "M")] as const));
    const value = harness(100, 7);
    value.panel.start();
    value.source.refreshCalls[0]?.value.resolve(snapshot({
      allFiles: paths,
      workspaceChanges: changes,
      sessionChanges: changes,
      workspaceSummary: { files: paths.length, insertions: paths.length, deletions: 0 },
      workspaceSummaryByPath: new Map(paths.map(path => [path, { insertions: 1, deletions: 0 }])),
    }));
    await settle();
    value.panel.render(100);
    for (let index = 0; index < 6; index += 1) value.panel.handleInput("n");
    value.panel.render(100);

    value.panel.handleInput("\x1b[<0;3;3M");
    expect(value.source.previewCalls.at(-1)?.path).toBe("file-3.ts");
  });

  test("directory and branch clicks select only, while Enter performs the branch switch", async () => {
    const directory = harness(100, 7);
    directory.panel.start();
    directory.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    directory.panel.render(100);
    directory.panel.handleInput("\x1b[<0;3;3M");
    expect(directory.source.previewCalls).toHaveLength(0);
    // Selection only: the click must not expand, collapse, or preview anything.
    expect(directory.panel.render(100).join("\n")).toContain("a.ts");

    const branches = harness(100, 7);
    branches.panel.start();
    branches.source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    branches.panel.handleInput("b");
    branches.source.branchesCalls[0]?.value.resolve({
      branches: [
        { name: "main", current: true },
        { name: "feature/ui", current: false },
      ],
      current: "main",
    });
    await settle();
    branches.panel.render(100);
    branches.panel.handleInput("\x1b[<0;3;4M");
    expect(branches.source.switchCalls).toHaveLength(0);
    branches.panel.handleInput("\r");
    expect(branches.source.switchCalls).toHaveLength(1);
    expect(branches.source.switchCalls[0]?.name).toBe("feature/ui");
  });

  test("uses selected and diff theme background tokens without changing visible width", async () => {
    const calls: string[] = [];
    const theme = {
      fg(color: ThemeColor, text: string): string {
        calls.push(color);
        return text;
      },
      bg(color: string, text: string): string {
        calls.push(`bg:${color}`);
        return text;
      },
      fgOnBg(color: ThemeColor, background: string, text: string): string {
        calls.push(`${color}/${background}`);
        return text;
      },
      bold(text: string): string {
        return text;
      },
    } as unknown as Theme;
    const { panel, source } = harness(100, 7, { theme });
    panel.start();
    source.refreshCalls[0]?.value.resolve(snapshot());
    await settle();
    panel.render(100);
    expect(calls).toContain("text/selectedBg");

    panel.handleInput("n");
    source.previewCalls.at(-1)?.value.resolve(preview("src/a.ts", "diff", ["+new", "-old", " context"]));
    await settle();
    panel.handleInput("\x1b[C");
    calls.length = 0;
    const lines = panel.render(100);
    expect(calls).toContain("toolDiffAdded/toolSuccessBg");
    expect(calls).toContain("toolDiffRemoved/toolErrorBg");
    expect(lines.every(line => visibleWidth(line) <= 100)).toBe(true);
  });
});
