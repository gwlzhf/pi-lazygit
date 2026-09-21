import { describe, expect, test } from "bun:test";
import type {
  ChangeRecord,
  CommitDiffPreview,
  FilePreview,
  GitBranchSnapshot,
  GitLogSnapshot,
  PreviewOptions,
  ProjectSnapshot,
  ReviewSource,
  StatusCode,
  SwitchBranchOptions,
} from "../contracts";
import { ReviewController } from "./review-controller";

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

class ControlledSource implements ReviewSource {
  readonly refreshes: { signal: AbortSignal; deferred: Deferred<ProjectSnapshot> }[] = [];
  readonly previews: { path: string; signal: AbortSignal; deferred: Deferred<FilePreview> }[] = [];
  readonly histories: { signal: AbortSignal; deferred: Deferred<GitLogSnapshot> }[] = [];
  readonly commitDiffs: { oid: string; signal: AbortSignal; deferred: Deferred<CommitDiffPreview> }[] = [];
  readonly branchesCalls: { signal: AbortSignal; deferred: Deferred<GitBranchSnapshot> }[] = [];
  readonly switches: { name: string; signal: AbortSignal; deferred: Deferred<void> }[] = [];
  readonly watches: ({ signal: AbortSignal; onChange: () => void; onError: (error: unknown) => void; deferred: Deferred<void> })[] = [];

  refresh({ signal }: { signal: AbortSignal }): Promise<ProjectSnapshot> {
    const value = deferred<ProjectSnapshot>();
    this.refreshes.push({ signal, deferred: value });
    return value.promise;
  }

  preview(path: string, { signal }: PreviewOptions): Promise<FilePreview> {
    const value = deferred<FilePreview>();
    this.previews.push({ path, signal, deferred: value });
    return value.promise;
  }

  history({ signal }: { signal: AbortSignal }): Promise<GitLogSnapshot> {
    const value = deferred<GitLogSnapshot>();
    this.histories.push({ signal, deferred: value });
    return value.promise;
  }

  commitDiff(oid: string, { signal }: PreviewOptions): Promise<CommitDiffPreview> {
    const value = deferred<CommitDiffPreview>();
    this.commitDiffs.push({ oid, signal, deferred: value });
    return value.promise;
  }

  branches({ signal }: { signal: AbortSignal }): Promise<GitBranchSnapshot> {
    const value = deferred<GitBranchSnapshot>();
    this.branchesCalls.push({ signal, deferred: value });
    return value.promise;
  }

  switchBranch(name: string, { signal }: SwitchBranchOptions): Promise<void> {
    const value = deferred<void>();
    this.switches.push({ name, signal, deferred: value });
    return value.promise;
  }

  watch(options: { signal: AbortSignal; onChange: () => void; onError: (error: unknown) => void }): Promise<void> {
    const value = deferred<void>();
    this.watches.push({ ...options, deferred: value });
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
    currentBranch: "main",
    allFiles: ["src/a.ts", "src/b.ts", "README.md"],
    workspaceChanges: new Map([
      ["src/a.ts", change("src/a.ts", "M")],
      ["src/b.ts", change("src/b.ts", "A")],
    ]),
    sessionChanges: new Map([["src/b.ts", change("src/b.ts", "A")]]),
    workspaceSummary: { files: 2, insertions: 1, deletions: 1 },
    workspaceSummaryByPath: new Map([
      ["src/a.ts", { insertions: 1, deletions: 1 }],
      ["src/b.ts", { insertions: 1, deletions: 0 }],
    ]),
    sessionSummary: { files: 1, insertions: 1, deletions: 0 },
    truncated: false,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ReviewController", () => {
  test("refreshes once, builds and recovers tree selection, and switches scopes", async () => {
    const source = new ControlledSource();
    let changes = 0;
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => changes += 1 });
    controller.start();
    expect(source.refreshes).toHaveLength(1);
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();

    expect(controller.state.snapshot?.kind).toBe("git");
    expect(controller.state.rows.map(row => row.node.path)).toEqual(["src", "src/a.ts", "src/b.ts"]);
    expect(controller.state.selectedIndex).toBe(0);
    expect(source.watches).toHaveLength(1);

    controller.setViewMode("all");
    expect(controller.state.rows.map(row => row.node.path)).toContain("README.md");
    controller.toggleScope();
    expect(controller.state.scope).toBe("session");
    expect(controller.state.rows.map(row => row.node.path)).toEqual(["src", "src/a.ts", "src/b.ts", "README.md"]);
    expect(changes).toBeGreaterThan(1);
    controller.dispose();
  });
  test("retires failed watches once and reinstalls on the next Git refresh", async () => {
    const source = new ControlledSource();
    let changes = 0;
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => changes += 1 });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    expect(source.watches).toHaveLength(1);

    const beforeError = changes;
    const watch = source.watches[0];
    watch?.onError(new Error("\x1b[31mwatch failed\x1b[0m"));
    watch?.deferred.reject(new Error("watch failed"));
    await settle();
    expect(changes).toBe(beforeError + 1);
    expect(controller.state.watchError).toBe("watch failed");
    expect(watch?.signal.aborted).toBe(true);

    controller.refresh();
    source.refreshes[1]?.deferred.resolve(snapshot());
    await settle();
    expect(source.watches).toHaveLength(2);
    controller.dispose();
  });

  test("loads previews, rejects stale results, and clamps scrolling", async () => {
    const source = new ControlledSource();
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => undefined });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    controller.expandOrChild();
    expect(source.previews.at(-1)?.path).toBe("src/a.ts");
    const first = source.previews.at(-1);
    controller.movePrimarySelection(1);
    const second = source.previews.at(-1);
    expect(first?.signal.aborted).toBe(true);
    expect(second?.path).toBe("src/b.ts");
    second?.deferred.resolve({ path: "src/b.ts", kind: "text", lines: ["1", "2", "3", "4"], truncated: false });
    await settle();
    controller.openSelection();
    controller.scrollPreviewEnd(2);
    expect(controller.state.previewScroll).toBe(2);
    first?.deferred.resolve({ path: "src/a.ts", kind: "text", lines: ["stale"], truncated: false });
    await settle();
    expect(controller.state.preview?.path).toBe("src/b.ts");
    controller.dispose();
  });
  test("clamps preview scroll against binary rows and split diff rows", async () => {
    const source = new ControlledSource();
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => undefined });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    controller.expandOrChild();
    source.previews[0]?.deferred.resolve({ path: "src/a.ts", kind: "binary", lines: [], byteSize: 8, truncated: false });
    await settle();
    controller.setPreviewWidth(100);
    controller.scrollPreviewEnd(1);
    expect(controller.state.previewScroll).toBe(1);

    controller.toggleDiffLayout();
    controller.cycleDiffContext();
    const diff = source.previews.at(-1);
    diff?.deferred.resolve({
      path: "src/a.ts",
      kind: "diff",
      lines: ["@@ -1,2 +1,2 @@", "-old", "+new", " context"],
      truncated: false,
    });
    await settle();
    controller.scrollPreviewEnd(1);
    expect(controller.state.previewScroll).toBe(2);
    controller.dispose();
  });

  test("loads and switches history commits while aborting previous diffs", async () => {
    const source = new ControlledSource();
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => undefined });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    controller.toggleLeftMode();
    source.histories[0]?.deferred.resolve({
      entries: [
        { oid: "a", shortOid: "a", subject: "first", author: "test", authoredAt: 1 },
        { oid: "b", shortOid: "b", subject: "second", author: "test", authoredAt: 2 },
      ],
      truncated: false,
    });
    await settle();
    expect(source.commitDiffs[0]?.oid).toBe("a");
    controller.movePrimarySelection(1);
    expect(source.commitDiffs[0]?.signal.aborted).toBe(true);
    expect(source.commitDiffs[1]?.oid).toBe("b");
    controller.dispose();
  });

  test("persists geometry changes and disposal aborts every request without late updates", async () => {
    const source = new ControlledSource();
    const ratios: number[] = [];
    let changes = 0;
    const controller = new ReviewController({
      cwd: "C:/repo",
      source,
      treeRatio: 0.2,
      onTreeRatioChange: ratio => ratios.push(ratio),
      onChange: () => changes += 1,
    });
    controller.start();
    const beforeDispose = changes;
    controller.setTreeColumns(20, 100);
    expect(ratios).toEqual([20 / 97]);
    expect(controller.state.treeRatio).toBe(20 / 97);
    controller.dispose();
    expect(source.refreshes[0]?.signal.aborted).toBe(true);
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    expect(changes).toBeGreaterThan(beforeDispose);
    const afterDispose = changes;
    controller.focusPreview();
    controller.setTreeCollapsed(true);
    expect(changes).toBe(afterDispose);
  });
  test("loads branches, switches once in order, refreshes the new branch, and restarts its watcher", async () => {
    const source = new ControlledSource();
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => undefined });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    const oldWatch = source.watches[0];

    controller.toggleBranches();
    expect(controller.state.leftMode).toBe("branches");
    expect(controller.state.branchLoading).toBe(true);
    expect(source.branchesCalls).toHaveLength(1);
    source.branchesCalls[0]?.deferred.resolve({
      branches: [
        { name: "main", current: true },
        { name: "feature/ui", current: false },
      ],
      current: "main",
    });
    await settle();
    expect(controller.state.branchSelectedIndex).toBe(0);
    controller.movePrimarySelection(1);
    expect(controller.state.branchSelectedIndex).toBe(1);

    controller.switchSelectedBranch();
    expect(oldWatch?.signal.aborted).toBe(true);
    expect(controller.state.branchSwitching).toBe("feature/ui");
    expect(source.switches).toHaveLength(1);
    controller.switchSelectedBranch();
    expect(source.switches).toHaveLength(1);

    source.switches[0]?.deferred.resolve();
    await settle();
    expect(controller.state.leftMode).toBe("files");
    expect(controller.state.refreshLoading).toBe(true);
    expect(source.refreshes).toHaveLength(2);
    source.refreshes[1]?.deferred.resolve(snapshot({ currentBranch: "feature/ui" }));
    await settle();
    expect(controller.state.snapshot?.currentBranch).toBe("feature/ui");
    expect(source.watches).toHaveLength(2);
    controller.dispose();
  });

  test("current branch Enter is a no-op and switch failure preserves branch selection", async () => {
    const source = new ControlledSource();
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => undefined });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    controller.toggleBranches();
    source.branchesCalls[0]?.deferred.resolve({
      branches: [
        { name: "main", current: true },
        { name: "feature/ui", current: false },
      ],
      current: "main",
    });
    await settle();

    controller.switchSelectedBranch();
    expect(source.switches).toHaveLength(0);
    expect(controller.state.leftMode).toBe("files");

    controller.toggleBranches();
    source.branchesCalls[1]?.deferred.resolve({
      branches: [
        { name: "main", current: true },
        { name: "feature/ui", current: false },
      ],
      current: "main",
    });
    await settle();
    controller.movePrimarySelection(1);
    controller.switchSelectedBranch();
    source.switches[0]?.deferred.reject(new Error("\x1b[31mrefused\x1b[0m"));
    await settle();

    expect(controller.state.leftMode).toBe("branches");
    expect(controller.state.branchSelectedIndex).toBe(1);
    expect(controller.state.branchSwitching).toBeUndefined();
    expect(controller.state.branchError).toBe("refused");
    expect(source.watches).toHaveLength(2);
    controller.dispose();
  });

  test("stale branch, refresh, and watcher callbacks cannot replace the new branch state", async () => {
    const source = new ControlledSource();
    const controller = new ReviewController({ cwd: "C:/repo", source, onChange: () => undefined });
    controller.start();
    source.refreshes[0]?.deferred.resolve(snapshot());
    await settle();
    const oldWatch = source.watches[0];

    controller.refresh();
    const staleRefresh = source.refreshes[1];
    controller.toggleBranches();
    const staleBranches = source.branchesCalls[0];
    controller.toggleBranches();
    controller.toggleBranches();
    const freshBranches = source.branchesCalls[1];
    freshBranches?.deferred.resolve({
      branches: [
        { name: "main", current: true },
        { name: "feature/ui", current: false },
      ],
      current: "main",
    });
    staleBranches?.deferred.resolve({
      branches: [{ name: "stale", current: true }],
      current: "stale",
    });
    await settle();
    expect(controller.state.branches?.branches.map(branch => branch.name)).toEqual(["main", "feature/ui"]);
    controller.movePrimarySelection(1);
    controller.switchSelectedBranch();
    const staleSnapshot = snapshot({ currentBranch: "stale" });
    staleRefresh?.deferred.resolve(staleSnapshot);
    oldWatch?.onChange();
    source.switches[0]?.deferred.resolve();
    await settle();
    expect(source.refreshes).toHaveLength(3);
    source.refreshes[2]?.deferred.resolve(snapshot({ currentBranch: "feature/ui" }));
    await settle();
    expect(controller.state.snapshot?.currentBranch).toBe("feature/ui");
    expect(controller.state.snapshot).not.toBe(staleSnapshot);
    controller.dispose();
  });
});
