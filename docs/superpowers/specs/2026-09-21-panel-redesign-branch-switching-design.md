# Panel Redesign and Branch Switching Design

## Goal

Redesign Pi Files Review around the compact two-pane layout shown in `screenshots.png`, normalize its primary shortcuts, add full-row diff and selection backgrounds, add mouse-driven tree selection in both hosts, and support safe switching among local Git branches.

The implementation must stay behaviorally aligned in:

- the OMP-only `master` worktree at `D:/ToolProject/pi-lazygit`;
- the dual-host `opencode-dual-host` worktree at `D:/ToolProject/pi-lazygit-opencode-dual`;
- the OMP renderer and the native OpenCode route in the dual-host worktree.

The release is `v0.5.0` because branch switching is a new repository-mutating capability.

## Scope

### Included

- Screenshot-inspired overview header, pane titles, compact footer, selected-row background, and diff-line background masks.
- A shared presentation policy for titles, status priority, contextual hints, and complete shortcut help.
- `n` / `p` as primary next/previous keys in files, history, and branches modes.
- A local-branch list in the left pane and ordinary `git switch` execution.
- Per-branch session baselines.
- Mouse selection of visible tree rows in OMP and OpenCode.
- Equivalent OMP and OpenCode behavior, adjusted only for native host rendering APIs.
- Documentation, package verification, version update, release tag, and both branch pushes.

### Excluded

- Hunk navigation and review-state marking shown in the reference screenshot.
- Remote branch discovery, fetch, tracking-branch creation, tag selection, commit checkout, or arbitrary ref input.
- Automatic stash, force checkout, conflict resolution, branch creation/deletion/rename, or any other Git mutation.
- A wholesale backport of the dual-host `ReviewController` architecture into the OMP-only branch.
- Exact color literals. All colors come from the active host theme.

## Repository Mutation Contract

Branch switching is the only new write operation. It is explicit: the user opens Branches mode, selects a local branch, and presses `Enter`.

The plugin executes an argument-vector command equivalent to:

```text
git switch --no-guess <local-branch-name>
```

No shell command string is constructed. Branch names are obtained from local refs, are passed as one process argument, and are still sanitized before display. The operation never adds `--force`, never stashes, and never deletes or rewrites refs.

A dirty worktree is delegated to Git's normal safety rules. A safe switch may carry changes to the target branch. A switch that would overwrite changes fails without retry or remediation. The sanitized Git error remains visible in Branches mode.

## Data Contracts

Add the following concepts to `src/contracts.ts` in both worktrees:

```ts
interface GitBranch {
  readonly name: string;
  readonly current: boolean;
}

interface GitBranchSnapshot {
  readonly branches: readonly GitBranch[];
  readonly current?: string;
  readonly detachedAt?: string;
}

interface SwitchBranchOptions {
  readonly signal: AbortSignal;
}

interface FileLineSummary {
  readonly insertions: number;
  readonly deletions: number;
}
```

`ReviewSource` gains:

```ts
branches(options: RefreshOptions): Promise<GitBranchSnapshot>;
switchBranch(name: string, options: SwitchBranchOptions): Promise<void>;
```

`ProjectSnapshot` gains:

- `currentBranch?: string` when HEAD is symbolic;
- `detachedAt?: string` when HEAD is detached;
- `workspaceSummaryByPath: ReadonlyMap<string, FileLineSummary>` for the selected-file `+N -N` title.

The per-file summaries come from the same bounded `git diff --numstat` inspection already used for the workspace total; rendering does not run another Git command. Filesystem snapshots use an empty map. A detached checkout can open Branches mode and switch to a listed local branch, but it is not represented as a selectable pseudo-branch.

## Git Backend

`GitRepository` adds branch enumeration, HEAD inspection, and switch operations.

Branch enumeration reads `refs/heads`, sorts names case-insensitively with the repository's existing deterministic tie-breaker, and marks the symbolic HEAD branch. Detached HEAD is reported with a short object ID. Output is bounded, validated as UTF-8, and parsed without shell interpolation.

`switchBranch` accepts only a name present in the latest local-branch snapshot or revalidates against a fresh enumeration immediately before execution. This prevents an arbitrary caller string from selecting a non-local ref. Successful execution invalidates cached inspection state. Git stderr is retained through the existing `GitOutputError` path.

`ProjectReviewSource` exposes the new operations only for Git backends. Filesystem fallback reports Git-only operation errors through the same contract as history and commit diff.

## Per-Branch Session Baselines

The current `BaselineStore` is keyed only by repository root. That would misclassify a branch switch as a large session edit. Change baseline identity to repository root plus HEAD identity:

- symbolic HEAD: `branch:<full-local-branch-name>`;
- detached HEAD: `detached:<full-object-id>`;
- unborn branch: `branch:<name>`.

The first visit to each identity captures a baseline. Returning to a previously visited branch reuses that branch's baseline. Switching branches does not delete another branch's baseline. Session shutdown still clears all in-memory baselines.

Concurrent capture coordination uses the same composite identity, preventing one branch's capture from satisfying another branch's waiters.

## Controller State and Branch Switching

The left-pane mode becomes:

```ts
type LeftMode = "files" | "log" | "branches";
```

Branch state includes:

- branch snapshot;
- selected branch index and viewport offset;
- loading, switching, and sanitized error state;
- generation and abort controller for stale-result suppression.

`b` enters Branches mode from files, history, or preview focus. Pressing `b` again or `Esc` returns to Files mode without changing branches. `Enter` on the current branch returns to Files mode without invoking Git. `Enter` on another branch starts one switch; repeated submissions are ignored until it settles.

Before switching, the controller:

1. clears text selection and notices;
2. cancels preview, history, commit-diff, refresh, and branch-list requests;
3. stops the active filesystem/Git watcher;
4. marks the branch row as switching.

On success it:

1. returns to Files mode and tree focus;
2. clears file/tree selection and viewport offsets that refer to the old branch;
3. performs a full refresh under the new HEAD identity;
4. restarts the watcher only after refresh establishes the new snapshot;
5. loads the selected file preview from the new tree when one exists.

On failure it remains in Branches mode, preserves the selected branch, displays the sanitized Git error, and restarts the watcher for the unchanged branch.

Generation checks ensure old watch callbacks, previews, refreshes, or branch results cannot overwrite post-switch state.

## Presentation Policy

Add a small pure presentation module in both worktrees. It receives a host-neutral projection of controller/panel state and returns:

- overview title;
- overview summary;
- left and right pane titles;
- priority status text;
- compact contextual actions;
- full help groups.

This module contains no ANSI or JSX and no Git execution. The OMP-only panel, dual-host OMP panel, and OpenCode route use the same labels and action ordering.

Status priority is:

1. switch/refresh/watch/preview error;
2. switching/loading;
3. copied/truncated notice;
4. steady-state summary.

Errors and progress replace lower-priority footer actions only as needed; they are never silently clipped away before decorative metadata.

## Layout

Wide layout uses three chrome rows:

1. overview header;
2. split pane-title border;
3. footer border.

Body height is terminal height minus those rows. Narrow layout uses the same overview/header/footer accounting but displays only the focused pane.

The overview header shows:

- left: `Diff working tree`, `Diff session`, `Project files`, `History`, or `Switch branch`;
- right: current branch or detached label, then the active file count.

The pane-title row shows the current directory/mode on the left and selected file path on the right. A diff preview appends the selected path's `workspaceSummaryByPath` value as `+N -N`. Missing entries omit the suffix rather than showing invented zeroes.

All rows remain exact-width under ANSI styling, combining characters, CJK width, and very small terminal dimensions. Existing truncation helpers remain authoritative.

## Diff and Selection Backgrounds

### OMP

- Selected tree/history/branch rows are padded to pane width and rendered with `selectedBg` plus a contrast-safe foreground.
- Unified addition rows are padded to preview width and rendered with `toolSuccessBg`.
- Unified deletion rows use `toolErrorBg`.
- Split diff cells independently apply success/error backgrounds, including gutter, marker, body, and padding. The opposite unchanged cell keeps its context background.
- Hunk and context rows keep theme-native foreground/background treatment rather than hardcoded RGB values.

### OpenCode

- Selected rows use `backgroundElement` and `selectedListItemText`.
- Diff rows/cells use `diffAddedBg`, `diffRemovedBg`, and `diffContextBg`, with matching diff foreground tokens.
- Text-selection highlighting remains above the diff mask and uses the host's selected-item tokens.

Background styling must not change visible width or copied text. OSC 52 selection copies plain preview content, not ANSI sequences.

## Keyboard Contract

Compact hints use the screenshot grammar: key first, short action second.

### Files, History, Branches

- `n` / `p`: next / previous row. These replace `j` / `k` in these modes.
- `Up` / `Down`: retained native navigation alternatives.
- `Enter`: open file, open commit preview, or switch branch according to mode.
- `Tab`: move pane focus.
- `b`: enter/leave Branches.
- `Esc`: leave Branches/help/preview first, then close from Files tree.

### Preview

- `j` / `k` and `Up` / `Down`: scroll one line.
- Existing page, home, end, focus, layout, context, copy, and width behavior remains.

### Existing Unique Commands

`d`, `c`, `m`, `a`, `s`, `g`, `r`, `\`, `t`, `[` and `]` retain their existing meanings. Redundant `F5` and `Ctrl` aliases may continue as unadvertised compatibility only where already accepted, but the compact footer and help present one primary mapping.

`?` toggles a complete shortcut help view. It does not discard the underlying selection, preview, or branch state. `?` or `Esc` closes help.

## Mouse Contract

Left-clicking a visible row in Files mode:

1. maps the screen row through overview/header offsets and the current tree viewport offset;
2. focuses the tree;
3. changes selection;
4. immediately starts the selected file preview, or clears preview for a directory;
5. requests one render showing the full-row selection background.

A directory click selects only; it does not implicitly expand. Existing keyboard expansion remains unchanged.

History and Branches rows use the same selection-only click behavior. Branch switching still requires `Enter`, preventing accidental repository mutation from one click.

Clicks on overview/header/footer, padding below the last row, borders, or the divider do not select an item. Divider drag and preview text drag retain precedence. Narrow tree mode uses the same row mapping; narrow preview mode has no tree target.

OpenCode already supports core tree clicking; its implementation is aligned with the new offsets and visual contract. Both OMP renderers gain the missing tree-click route.

## Error Handling

- Every Git and filesystem error is sanitized before rendering.
- Branch enumeration failure leaves existing file review usable.
- Branch switch failure never triggers a speculative refresh under a new branch.
- A refresh failure after a successful switch reports the new branch and leaves manual `r` recovery available.
- Aborts are control flow, not user-facing errors.
- Invalid or disappearing branch selections are recovered to the nearest surviving row.
- Empty repositories and unborn branches list their local branch when Git exposes it; otherwise Branches mode shows an empty-state message.

## Tests

Development follows TDD. Observable contracts include:

### Git and source

- local branches only, deterministic order, current marker, detached HEAD;
- bounded/validated output and exact argv execution;
- successful switch and Git-refused dirty switch;
- no stash, force, fetch, or shell execution;
- per-branch baseline capture and restoration;
- filesystem fallback rejection.

### Controller and panel

- Branches mode loading, selection, no-op current branch, switching lock, success, failure, watcher restart, and stale-result suppression;
- `n/p` replace `j/k` only in files/history/branches while preview `j/k` remains scroll;
- `b`, `?`, and layered `Esc` behavior;
- mouse row selection after scrolling, in wide/narrow layouts, and with new header offsets;
- click on a branch selects without switching.

### Rendering

- exact overview/pane/footer frames at wide, narrow, and tiny dimensions;
- full-row selected backgrounds;
- unified addition/removal masks;
- split-cell masks with gutters and padding;
- OpenCode theme background tokens;
- ANSI width, CJK, combining characters, sanitization, and text-copy invariants.

### Verification

- `bun run check` in both worktrees;
- `bun run assert-pack` in the dual-host worktree;
- a real temporary Git repository smoke that creates two local branches, switches successfully, and verifies a conflicting dirty switch is refused without data loss;
- one actual OMP TUI interaction covering mouse tree selection, branch switching, and diff masks;
- one actual OpenCode route interaction covering the same visible states where the host is available.

## Parallel Implementation

After plan approval, dispatch one batch of multiple `task` agents. The tool interface does not expose a model selector, so no model identity is asserted.

Ownership is disjoint:

1. **OMP-only worktree owner** — contracts, Git/source/baseline, panel behavior/rendering/tests in `D:/ToolProject/pi-lazygit`.
2. **Dual core and OMP owner** — contracts, Git/source/baseline, `ReviewController`, OMP panel, and tests in `D:/ToolProject/pi-lazygit-opencode-dual`; does not edit `src/opencode/**`.
3. **Dual OpenCode owner** — `src/opencode/**` route/input/rendering/tests only; consumes the agreed controller fields and methods, and does not edit shared contracts/controller files.

All agents skip formatters, builds, linters, test suites, release edits, commits, tags, and pushes. Shared interfaces and exact names are fixed in the implementation plan before dispatch. Main thread integrates all results, resolves interface drift, updates docs/version, runs the complete acceptance pass once, then commits and releases.

## Documentation and Release

Update both READMEs for:

- new layout and screenshot-inspired visual hierarchy;
- branch mutation warning and safety behavior;
- local-branch-only selector and `b` key;
- normalized shortcuts and `?` help;
- mouse tree selection;
- diff background masks.

User-owned untracked `screenshots.png` and dual-worktree `.opencode/` remain untracked and untouched.

Both package versions and installation references become `0.5.0`. Because Git tags are repository-global, create one `v0.5.0` tag on the verified `opencode-dual-host` release commit. That commit is the dual-host superset and retains the OMP entry point and optional OpenCode peers. Push `master`, `opencode-dual-host`, and `v0.5.0` only after both worktrees pass acceptance.
