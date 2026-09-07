# Pi Files Review Extension Design

## Goal

Build an installable Oh My Pi extension for reviewing project changes without leaving the current PowerShell/Windows Terminal OMP session. `/files` and `Ctrl+Shift+G` open a keyboard-driven file tree on the left and a selected-file diff or content preview on the right.

The extension is a focused review surface, not a file editor, Git client, or replacement for Yazi.

## Supported environment

- Oh My Pi interactive TUI, validated against `omp/18.0.11`
- Windows PowerShell and Windows Terminal as the primary environment
- Git repositories, including repositories without an initial commit
- Non-Git directories through a read-only filesystem-browser fallback

Headless, RPC, and ACP modes do not mount the panel. Invoking `/files` without the interactive TUI reports that the UI is unavailable and returns.

## User interface

### Entry points

- `/files` opens the review panel.
- `Ctrl+Shift+G` opens the same panel through an extension shortcut.
- Both entry points call one `openFileReview` function and cannot open duplicate nested panels.

### Layout

At sufficient width, the panel uses a bordered 42%/58% split:

```text
┌─ Project [modified · workspace] ───┬─ Diff: src/auth/login.ts ─────┐
│ ▼ src                              │ @@ -18,7 +18,7 @@             │
│   ▼ auth                           │ - const timeout = 1000        │
│     M  login.ts              ←     │ + const timeout = 5000        │
│     A  token.ts                    │                               │
│ ▼ tests                            │                               │
│   M  auth.test.ts                  │                               │
├────────────────────────────────────┴───────────────────────────────┤
│ auth-fix · +64 -22 · 4 files · m/a mode · s scope · r refresh     │
└────────────────────────────────────────────────────────────────────┘
```

At narrow widths, the component becomes single-pane. The tree is shown first; opening a file replaces it with a full-width preview. Every rendered line must fit the terminal's visual width.

### Tree controls

- `Up`/`Down` and `j`/`k`: move selection.
- `Left`/`Right` and `h`/`l`: collapse or expand directories.
- `Enter`: toggle a directory or focus/open a file preview.
- `m`: modified-files mode.
- `a`: all-files mode.
- `s`: toggle workspace/session scope.
- `r`: refresh status, tree, summary, and selected preview.
- `Esc`: close from the tree.

Mode and scope are orthogonal. In modified mode, the tree contains only changes from the active scope. In all-files mode, the tree contains every Git-visible file, while status markers, footer totals, and directory emphasis reflect only changes from the active scope. Consequently, `all + session` remains a complete project tree with only post-baseline changes highlighted.

Tree rows display a compact status marker: `M`, `A`, `D`, `R`, `?`, or `U`. A directory remains visible when it contains any visible descendant. Conflict status uses the theme's error color.

### Preview controls

- `Up`/`Down`, `j`/`k`, `PageUp`/`PageDown`, and `Home`/`End`: scroll.
- `Left`, `h`, or `Esc`: return focus to the tree.
- Selecting a file starts preview loading immediately; `Enter` transfers focus to the preview.

Tracked files show a unified diff from `HEAD` to the working tree, combining staged and unstaged changes. Deleted files show their deletion diff. Untracked text files show read-only content with line numbers. Unchanged files in all-files mode show read-only content with line numbers.

The preview colors additions, deletions, hunk headers, and file headers using the active OMP theme. Syntax highlighting is out of scope.

### Footer

The footer shows:

- OMP session name when available
- active view mode: modified or all files
- active scope: workspace or session
- insertions, deletions, and visible changed-file count
- loading, truncation, baseline, or error state
- concise key hints

In a non-Git directory it identifies filesystem mode and omits Git statistics and scope controls.

## Data model and module boundaries

### GitRepository

Runs the installed Git executable directly with argument arrays and no command-string interpolation. It:

- resolves the repository root;
- reads `git status --porcelain=v1 -z` status records;
- lists tracked and untracked/non-ignored paths;
- loads `HEAD`-to-working-tree diffs;
- computes summary statistics;
- detects repositories without `HEAD`.

NUL-delimited Git output is required wherever path output is parsed, preserving spaces, Unicode, and rename paths. Gitignored files and `.git` internals are never included in all-files mode.

### SessionBaseline

At baseline time, the extension records the status and content hash of every currently changed or untracked Git-visible file. A tracked file that is clean at baseline needs no hash: if Git later reports it as changed, it is new to the session. On refresh, session scope includes only currently changed Git-visible files whose status or content differs from the recorded baseline. A file restored to its baseline content disappears from session scope.

This is explicitly temporal attribution: changes made by any process after the baseline are included. It does not claim the Agent made every listed change.

The active repository is captured during `session_start`. If the session later visits another repository, that repository receives a baseline on first access and the footer discloses the establishment time. Baselines are in-memory only and reset when OMP restarts.

### ProjectTree

Builds an ordered hierarchy from normalized relative paths. It owns:

- directory aggregation and status propagation;
- expanded directory state;
- flattening visible rows;
- selection recovery after refresh;
- filtering by modified/all mode and workspace/session scope.

Directory-first, case-insensitive display ordering is used while preserving the original path spelling. Git path separators are normalized to `/` for model identity and display.

### PreviewLoader

Loads one selected file preview and returns structured lines plus metadata. Requests carry monotonically increasing versions. A completed stale request is discarded, preventing rapid navigation from replacing the current file with an older result.

Limits:

- at most 1 MiB of source/diff input per preview;
- at most 5,000 rendered logical lines;
- an explicit truncation marker when either limit is reached.

Binary files show path, Git status, byte size when available, and `Binary file`; their bytes are not rendered. File read and Git errors become preview error states without closing the panel.

### FilesPanel

A pure OMP TUI component and input state machine. It owns layout, focus, scrolling, key handling, render caching, and refresh orchestration. It depends on interfaces supplied by the data modules rather than invoking Git parsing internally.

`dispose()` is idempotent, aborts outstanding work, and prevents later render callbacks. Closing the custom UI restores the exact prior editor text and focus through `ctx.ui.custom`.

### Extension entry point

Registers:

- the `files` slash command;
- the `Ctrl+Shift+G` shortcut;
- session lifecycle handlers needed to initialize and clear baselines.

Registration occurs during extension load. Runtime UI actions occur only in commands, shortcuts, or lifecycle handlers after initialization.

## Refresh and error semantics

A refresh:

1. resolves the current Git repository or chooses filesystem fallback;
2. loads status, visible paths, and summary concurrently where safe;
3. rebuilds the filtered tree;
4. preserves the selected path and expanded directories when still valid;
5. selects the nearest remaining row otherwise;
6. loads the selected preview;
7. requests one repaint.

While refreshing, the prior successful tree and preview remain visible with a loading footer. A top-level refresh failure preserves that view and displays the error. A selected-file failure affects only the right pane.

No shell commands are constructed from repository paths. External output is sanitized before rendering: tabs are expanded, control sequences are removed or neutralized, and ANSI-aware terminal utilities enforce visible width.

## Non-Git fallback

Outside a Git repository, `/files` remains useful as a read-only project browser:

- the root is `ctx.cwd`;
- the tree recursively includes ordinary filesystem entries except `.git`;
- ignored-file semantics are unavailable, so traversal includes every ordinary entry except `.git`, subject to the hard entry limit;
- file previews use line-numbered text or binary metadata;
- modified mode and workspace/session scope are disabled because no Git baseline exists.

Traversal stops after 20,000 entries. Reaching the limit produces a visible truncation state instead of blocking the OMP process.

## Packaging

The repository is an installable TypeScript OMP plugin package named `pi-lazygit`. Its manifest uses `omp.extensions` to point to the extension entry. Runtime dependencies are limited to OMP packages and small utilities already provided by the OMP SDK; Git remains an external executable.

The package includes build, typecheck, and test scripts plus installation instructions for local `omp plugin link`, explicit `--extension`, and package installation workflows.

## Testing and verification

### Unit tests

- porcelain `-z` parsing, including rename, conflict, spaces, and Unicode;
- project-tree construction, ordering, filtering, expansion, and selection recovery;
- workspace/session baseline comparison;
- key-driven focus, mode, scope, expansion, and scrolling transitions;
- visual-width clipping, sanitization, binary metadata, and preview truncation.

### Git integration tests

Temporary repositories cover:

- combined staged and unstaged changes relative to `HEAD`;
- added, deleted, and renamed files;
- untracked files;
- repositories without `HEAD`;
- Unicode paths and paths containing spaces;
- non-Git fallback behavior.

### Rendering tests

Deterministic component rendering covers wide split-pane and narrow single-pane layouts, empty repositories, loading/errors, visible selection, scroll bounds, and footer statistics.

### End-to-end smoke verification

After build and automated checks, launch the installed `omp/18.0.11` executable from PowerShell with the local extension in a temporary Git repository. Exercise `/files`, `Ctrl+Shift+G`, `m`, `a`, `s`, `r`, `Enter`, preview scrolling, and `Esc`. Verify the real terminal surface and that closing restores the prior OMP editor state.

## Parallel implementation plan boundary

Implementation is decomposed only after the public interfaces are fixed in the implementation plan:

1. Git data layer and temporary-repository integration tests.
2. Tree model and session baseline.
3. TUI component, layout, rendering, and input state machine.
4. Extension entry, shortcut, package manifest, and installation surface.
5. One integration owner connects modules, resolves shared-file changes, and performs final behavioral verification.

Agents skip project-wide validation while working. The integration owner runs the complete checks once all modules are merged.

## Explicit non-goals

- Editing files or applying/reverting hunks
- Staging, committing, branching, or other Git mutations
- Syntax highlighting
- Replacing Yazi or Lazygit
- Exact attribution of a change to a particular Agent tool call
- Persisting session baselines across OMP restarts
