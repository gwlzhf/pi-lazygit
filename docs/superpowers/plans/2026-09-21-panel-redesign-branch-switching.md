# Panel Redesign and Branch Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the screenshot-inspired two-pane redesign, theme-backed diff masks, mouse tree selection, normalized keys, and safe local-branch switching in the OMP-only and dual-host worktrees, then release `v0.5.0`.

**Architecture:** Three disjoint agents work in synchronized parallel RED and GREEN waves: OMP-only implementation, dual shared-core/OMP implementation, and dual OpenCode implementation. RED agents write tests only; main thread proves the tests fail for the missing behavior; GREEN agents then implement against those tests. Both repositories use the same contracts and presentation vocabulary; the dual OpenCode slice consumes controller interfaces fixed below. Main thread performs one final integration and acceptance pass, then owns docs, versioning, commits, tag, and pushes.

**Tech Stack:** TypeScript 5.9, Bun 1.3, Git CLI, `@oh-my-pi/pi-coding-agent`/`pi-tui` 18.0.11, OpenCode plugin 1.18.31, OpenTUI/Solid 0.5.11/1.9.12.

**Spec:** `docs/superpowers/specs/2026-09-21-panel-redesign-branch-switching-design.md`

## Global Constraints

- Local branches only; never fetch, create, rename, delete, stash, or force.
- Execute Git through `ProcessRunner` argv; never construct a shell command.
- Dirty-worktree safety is ordinary `git switch --no-guess <name>` behavior.
- Session baselines are keyed by repository root plus HEAD identity.
- `n/p` replace `j/k` only in files/history/branches; preview `j/k` remains scroll.
- Direction keys remain accepted. Existing unique `d/c/m/a/s/g/r/\/t/[ ]` actions remain.
- A branch row click selects only; `Enter` is required to mutate the repository.
- OMP and OpenCode use host theme tokens; no hardcoded RGB colors.
- `screenshots.png` and dual `.opencode/` are user-owned untracked paths and must remain untouched.
- Parallel workers write either tests (RED wave) or production code (GREEN wave) as instructed. They do not run tests/builds, format project-wide, commit, tag, publish, or push. Main thread proves RED between waves and validates GREEN once after integration.

## Fixed Shared Interfaces

Both worktrees use these exported contracts in `src/contracts.ts`:

```ts
export interface FileLineSummary {
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitBranch {
  readonly name: string;
  readonly current: boolean;
}

export interface GitBranchSnapshot {
  readonly branches: readonly GitBranch[];
  readonly current?: string;
  readonly detachedAt?: string;
}

export interface SwitchBranchOptions {
  readonly signal: AbortSignal;
}

export interface ReviewSource {
  refresh(options: RefreshOptions): Promise<ProjectSnapshot>;
  preview(path: string, options: PreviewOptions): Promise<FilePreview>;
  history(options: RefreshOptions): Promise<GitLogSnapshot>;
  commitDiff(oid: string, options: PreviewOptions): Promise<CommitDiffPreview>;
  branches(options: RefreshOptions): Promise<GitBranchSnapshot>;
  switchBranch(name: string, options: SwitchBranchOptions): Promise<void>;
  watch(options: WatchOptions): Promise<void>;
}
```

`ProjectSnapshot` adds:

```ts
readonly currentBranch?: string;
readonly detachedAt?: string;
readonly workspaceSummaryByPath: ReadonlyMap<string, FileLineSummary>;
```

`RepositoryBaseline` adds `readonly headIdentity: string`. `BaselineStore.capture/get/compare` receive `headIdentity` immediately after `root`.

Dual `ReviewControllerState` adds exactly:

```ts
readonly leftMode: "files" | "log" | "branches";
readonly branches: GitBranchSnapshot | undefined;
readonly branchSelectedIndex: number;
readonly branchLoading: boolean;
readonly branchSwitching: string | undefined;
readonly branchError: string | undefined;
```

Dual `ReviewController` exposes exactly:

```ts
toggleBranches(): void;
switchSelectedBranch(): void;
```

Existing `selectPrimary(index)` selects the active files/log/branches row. `movePrimarySelection(delta)` moves within the active mode.

The host-neutral presentation module is `src/ui/presentation.ts` in both worktrees:

```ts
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

export function panelPresentation(input: PanelPresentationInput): PanelPresentation;
export const PANEL_HELP_GROUPS: readonly {
  readonly title: string;
  readonly actions: readonly PanelAction[];
}[];
```

Presentation output uses `Diff working tree`, `Diff session`, `Project files`, `History`, and `Switch branch`; compact action order is focus, movement, primary action, mode switch, help.

---

## Parallel TDD Protocol

1. Dispatch Tasks 1–3 together for their test steps only. Each agent stops before modifying production files.
2. Main thread runs the focused commands from Task 4 Step 2. Every new test must fail for missing branch/presentation/mouse/background behavior, not syntax, fixture, or import errors.
3. Dispatch Tasks 1–3 together again for production steps only, carrying the recorded RED failures. Agents must not weaken or delete the failing assertions.
4. Main thread runs Task 4 integration and Task 6 acceptance once. Any newly exposed defect receives a failing regression test before its source fix.

This split satisfies test-first development while preserving the user's requirement for multiple parallel Task agents and one combined acceptance pass.

## Parallel Wave

### Task 1: OMP-Only Worktree

**Ownership:** `D:/ToolProject/pi-lazygit` only. Do not edit the dual worktree.

**Files:**
- Create: `src/ui/presentation.ts`
- Create: `src/ui/presentation.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/contracts.test.ts`
- Modify: `src/git/repository.ts`
- Modify: `src/git/repository.integration.test.ts`
- Modify: `src/model/baseline.ts`
- Modify: `src/model/baseline.test.ts`
- Modify: `src/review-source.ts`
- Modify: `src/review-source.test.ts`
- Modify: `src/ui/render.ts`
- Modify: `src/ui/render.test.ts`
- Modify: `src/ui/files-panel.ts`
- Modify: `src/ui/files-panel.test.ts`
- Modify: `package.json` only to add `src/ui/presentation.ts` to `files`; do not change version.

**Interfaces:**
- Consumes: Fixed Shared Interfaces above and existing `ProcessRunner`, `GitOutputError`, diff row, ANSI width, selection, tree, and watch helpers.
- Produces: Complete OMP-only behavior and tests; no dual-host files.

- [ ] **Step 1: Add contract and baseline tests before implementation**

Add assertions equivalent to:

```ts
test("keeps independent baselines for local branches", async () => {
  await store.capture(root, "branch:main", mainChanges, hashFile, signal, 1);
  await store.capture(root, "branch:feature", featureChanges, hashFile, signal, 2);
  expect(store.get(root, "branch:main")?.establishedAt).toBe(1);
  expect(store.get(root, "branch:feature")?.establishedAt).toBe(2);
});
```

Update every fake `ProjectSnapshot` and `ReviewSource` with `workspaceSummaryByPath`, `branches`, and `switchBranch`. Add a source test proving first refresh on `feature` does not reuse `main` baseline.

- [ ] **Step 2: Add real Git branch tests before implementation**

Use existing temporary repositories. Cover:

```ts
expect(await repository.branches(signal)).toEqual({
  branches: [
    { name: "feature/ui", current: false },
    { name: "main", current: true },
  ],
  current: "main",
});
```

Also cover detached HEAD, successful `switchBranch("feature/ui")`, and a conflicting dirty switch that rejects while preserving the dirty file. A scripted runner test must assert no argv contains `stash`, `force`, `fetch`, or a shell executable.

- [ ] **Step 3: Implement HEAD inspection, branch listing, switch, and per-file summaries**

Replace boolean-only HEAD detection with one inspection that returns `hasHead`, `headIdentity`, `currentBranch`, and `detachedAt`. Reuse full OID in `headIdentity`; show only short OID in `detachedAt`. Implement bounded local-ref enumeration and fresh-name validation before:

```ts
await this.run(["switch", "--no-guess", name], signal, SMALL_GIT_OUTPUT);
```

Populate `workspaceSummaryByPath` from existing inspection `summaryByPath`. Invalidate `latestInspection` after a successful switch.

- [ ] **Step 4: Implement per-branch source baselines**

Change `BaselineStore` map keys and capture coordination keys to canonical root plus `headIdentity`. Pass the identity through `ProjectReviewSource.refresh`. Add `branches` and `switchBranch` methods that reject filesystem fallback and delegate to the active Git backend.

- [ ] **Step 5: Add presentation and visual tests before implementation**

Test exact titles/actions for files, preview, history, branches, filesystem, detached HEAD, errors, and narrow metadata. Extend fake theme recording to assert:

```ts
expect(calls).toContain("toolDiffAdded/toolSuccessBg");
expect(calls).toContain("toolDiffRemoved/toolErrorBg");
expect(calls).toContain("text/selectedBg");
```

Add exact frame tests for overview row + pane title + body + footer. Add unified and split diff width assertions under ANSI, CJK, and combining text.

- [ ] **Step 6: Implement presentation and masked rendering**

Implement `panelPresentation` and `PANEL_HELP_GROUPS`. In `render.ts`, pad before styling and use `theme.fgOnBg` for added/removed cells. Add a selected-row helper that paints the full padded row with `selectedBg`. Context and hunk text stay on normal theme background.

- [ ] **Step 7: Add input, branch-mode, help, and mouse tests before implementation**

Tests must prove:

- files/history/branches accept `n/p` and no longer treat `j/k` as row movement;
- preview still treats `j/k` as scroll;
- `b` loads branches; current branch `Enter` is a no-op; another branch switches once;
- switch failure stays in Branches with sanitized error; success returns Files and restarts watch;
- `?` preserves underlying state and `Esc` closes help first;
- clicking a scrolled visible file row focuses tree, selects correct absolute row, and starts preview;
- clicking a directory selects without expansion; clicking a branch never switches.

- [ ] **Step 8: Implement OMP panel state and geometry**

Add branch request/switch generations and abort controllers mirroring existing refresh/history patterns. Add overview header row, set content height to `terminalRows - 3`, and update mouse body origin to row 2. Route tree clicks before preview drag logic; keep divider and preview selection precedence. Use the presentation module for titles/footer/help and per-file `+N -N`.

- [ ] **Step 9: Leave slice ready for integration**

Do not run commands or commit. Report changed files, exported interfaces, and any mismatch against this plan.

### Task 2: Dual Shared Core and OMP Renderer

**Ownership:** `D:/ToolProject/pi-lazygit-opencode-dual`, excluding `src/opencode/**`. Do not edit primary worktree or OpenCode files.

**Files:**
- Create: `src/ui/presentation.ts`
- Create: `src/ui/presentation.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/contracts.test.ts`
- Modify: `src/git/repository.ts`
- Modify: `src/git/repository.integration.test.ts`
- Modify: `src/model/baseline.ts`
- Modify: `src/model/baseline.test.ts`
- Modify: `src/review-source.ts`
- Modify: `src/review-source.test.ts`
- Modify: `src/ui/review-controller.ts`
- Modify: `src/ui/review-controller.test.ts`
- Modify: `src/ui/render.ts`
- Modify: `src/ui/render.test.ts`
- Modify: `src/ui/files-panel.ts`
- Modify: `src/ui/files-panel.test.ts`
- Modify: `src/package.test.ts`
- Modify: `package.json` only to add `src/ui/presentation.ts` to `files`; do not change version.

**Interfaces:**
- Consumes: Fixed Shared Interfaces above.
- Produces: Exact `ReviewControllerState`, `toggleBranches`, and `switchSelectedBranch` contract consumed concurrently by Task 3.

- [ ] **Step 1: Add the same observable core contracts independently**

Write dual-worktree tests for branch enumeration, ordinary switch safety, per-branch baselines, source delegation, and `workspaceSummaryByPath`. Do not copy test paths from the primary worktree at runtime; all fixtures live in this worktree.

- [ ] **Step 2: Implement dual Git/source/baseline core**

Implement the exact contract and behavior stated in Task 1 Steps 3–4. Preserve dual-host optional dependency boundaries. Update package tests to require `src/ui/presentation.ts` in the packed file list.

- [ ] **Step 3: Add controller branch transition tests before implementation**

Use `ControlledSource` to assert this order:

```text
toggleBranches -> branches pending -> list resolved -> select feature
-> switchSelectedBranch -> watch aborted -> switch pending
-> switch resolved -> files mode -> refresh pending
-> refresh resolved -> watch restarted
```

Assert switch rejection keeps branches mode, selected index, and error; a second Enter while pending produces no second source call; stale refresh/preview/watch callbacks cannot replace new-branch state.

- [ ] **Step 4: Implement controller branch state**

Extend `LeftMode`, state snapshots, `movePrimarySelection`, and `selectPrimary`. Implement `toggleBranches` and `switchSelectedBranch` with generation guards and watcher lifecycle. Current-branch Enter exits without calling `switchBranch`. Sanitize errors with the existing controller helper.

- [ ] **Step 5: Add presentation/render/panel tests before implementation**

Cover exact shared presentation output, OMP background calls, overview/pane/footer frames, help, `n/p`, and tree mouse selection at scrolled offsets. Ensure branch click selects only. Keep preview selection/OSC 52 tests green by preserving plain copied text.

- [ ] **Step 6: Implement dual OMP presentation and mouse behavior**

Use the same presentation API and OMP theme semantics as Task 1. Update chrome/body row accounting to three rows. Render files/log/branches through active-mode offsets. Route clicks through controller `selectPrimary`; only keyboard Enter calls `switchSelectedBranch`.

- [ ] **Step 7: Leave slice ready for integration**

Do not run commands or commit. Report changed files and confirm Task 3 can consume the fixed controller interface without another shared-file edit.

### Task 3: Dual OpenCode Route

**Ownership:** `D:/ToolProject/pi-lazygit-opencode-dual/src/opencode/**` only. Do not edit shared contracts, controller, OMP files, package metadata, or primary worktree.

**Files:**
- Modify: `src/opencode/files-route.tsx`
- Modify: `src/opencode/files-route.test.tsx`

**Interfaces:**
- Consumes: Fixed Shared Interfaces and Task 2's exact `ReviewControllerState`, `toggleBranches()`, `switchSelectedBranch()`, `selectPrimary()`, and `movePrimarySelection()`.
- Produces: Native OpenCode route behavior and tests without shared-file edits.

- [ ] **Step 1: Add binding and key-handler tests before implementation**

Require bindings for `n`, `p`, `b`, and `?`. Tests must assert `j/k` do not move files/history/branches, preview `j/k` still scroll, `n/p` move the active primary list, `b` toggles branches, Branches Enter calls `switchSelectedBranch`, and help captures `Esc` before route exit.

- [ ] **Step 2: Add mouse geometry tests before implementation**

Raise `BODY_TOP` for overview + border content. Cover files, log, and branch viewport offsets; footer/header/padding clicks ignored; branch click selects but does not switch; divider drag and preview selection retain precedence.

- [ ] **Step 3: Add visual token tests before implementation**

Capture OpenTUI frames or render spans and assert:

- overview title/meta and contextual footer actions;
- selected tree/log/branch row uses `backgroundElement` and `selectedListItemText` across padded width;
- addition/deletion/context rows use `diffAddedBg`, `diffRemovedBg`, `diffContextBg`;
- split cells use their own background through gutter/body/padding;
- selected preview text remains above the diff background.

- [ ] **Step 4: Implement OpenCode route integration**

Consume `panelPresentation` from `../ui/presentation`. Add overview row, branch list rendering/loading/switch/error states, compact footer, and help view. Track `branchOffset` separately from tree/log offsets. Use `n/p` in primary modes, retain preview `j/k`, and keep native direction keys.

- [ ] **Step 5: Implement OpenCode background masks**

Return `<span>` nodes with both `fg` and `bg` tokens. Fill each rendered line/cell to the available width before applying styles. Selection spans use selected-item colors over the diff token background and do not alter copied text.

- [ ] **Step 6: Leave slice ready for integration**

Do not run commands or commit. Report changed files and every consumed controller field/method so main thread can resolve drift once.

---

## Main-Thread Integration and Acceptance

### Task 4: Integrate Parallel Results

**Files:** All files changed by Tasks 1–3; only main thread resolves cross-slice interface mismatches.

- [ ] **Step 1: Inspect agent receipts and reconcile exact interfaces**

Confirm no agent touched another owner's paths, user-owned untracked files, version fields, README install tags, Git refs, or remote state. Reconcile Task 2 and Task 3 strictly to the Fixed Shared Interfaces; remove duplicate presentation or branch logic.

- [ ] **Step 2: Run focused contract tests once**

Run in each worktree:

```powershell
bun test src/model/baseline.test.ts src/review-source.test.ts src/git/repository.integration.test.ts src/ui/presentation.test.ts src/ui/render.test.ts src/ui/files-panel.test.ts
```

Additionally in the dual worktree:

```powershell
bun test src/ui/review-controller.test.ts src/opencode/files-route.test.tsx
```

Expected: all listed tests pass. The known Windows 8.3-path test may fail only with the previously documented expected/actual path casing difference; no new failure is accepted.

- [ ] **Step 3: Fix integration failures at their source**

For type/interface failures, update producer and every consumer together. For visual-width failures, pad before applying ANSI/theme styles. For switch races, fix generation/watch lifecycle rather than relaxing tests.

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `D:/ToolProject/pi-lazygit-opencode-dual/README.md`
- [ ] **Step 1: Update both READMEs**

Document branch mutation warning, local-only selector, dirty-worktree Git safety, per-branch session baseline, `b`, `n/p`, `?`, mouse tree selection, overview layout, selected-row background, and diff masks. Replace old key tables rather than adding a second convention. Keep package versions and existing install-tag references unchanged until the dedicated release commits.

### Task 6: Single Acceptance Pass

- [ ] **Step 1: Run complete automated checks**

Run with context-mode capture:

```powershell
bun run check
```

in both worktrees, then:

```powershell
bun run assert-pack
```

in the dual worktree. Expected: typecheck and all tests pass, except the already documented Windows 8.3-path environment mismatch if it reproduces unchanged.

- [ ] **Step 2: Exercise a real Git switch smoke**

Use the integration fixture or a disposable repository to create `main` and `feature`, make branch-specific content, switch through the plugin source API, then create an overlapping dirty edit and verify Git refuses the switch without content loss. Record branch before/after and file content; do not use stash or force.

- [ ] **Step 3: Exercise actual OMP TUI**

Launch:

```powershell
omp --extension ./src/index.ts
```

Open `/files`; verify overview/pane/footer layout, click two visible files, observe full-row selection, open a diff and observe add/remove backgrounds, press `b`, select with `n/p`, switch with `Enter`, and use `?`/`Esc`. Capture terminal output/state as evidence, then exit cleanly.

- [ ] **Step 4: Exercise actual OpenCode route**

Launch the dual worktree with its existing local `.opencode/tui.json`, open `pi-lazygit.files`, and verify the same visible states and branch flow. `.opencode/` remains untracked and unchanged.

### Task 7: Commit, Release, and Push

- [ ] **Step 1: Commit primary feature**

Stage exact tracked source/test/docs/package paths, excluding `screenshots.png`, and commit:

```text
feat: redesign review panel and switch branches
```

- [ ] **Step 2: Commit dual feature**

Stage exact tracked source/test/docs/package paths, excluding `.opencode/`, and use the same feature subject.

- [ ] **Step 3: Release primary as `v0.5.0` metadata**

Set primary `package.json` version to `0.5.0` and replace its README `#v0.3.2` install references with `#v0.5.0`. Commit only those release metadata lines:

```text
chore: release v0.5.0
```

- [ ] **Step 4: Release dual as `v0.5.0` metadata**

Set dual `package.json` version to `0.5.0` and replace its README `#v0.4.2` install references with `#v0.5.0`. Run `bun run assert-pack` against the edited package, then commit only those release metadata lines with `chore: release v0.5.0`.

- [ ] **Step 5: Tag verified dual release commit**

```powershell
git tag v0.5.0
```

Confirm the tag does not already exist before creation.

- [ ] **Step 6: Push both branches and tag**

From the respective worktrees:

```powershell
git push origin master
git push origin opencode-dual-host
git push origin v0.5.0
```

Report pushed commit IDs, tag target, automated check results, real TUI observations, and any known unchanged environment-only failure.
