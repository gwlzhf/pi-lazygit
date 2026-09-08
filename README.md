# Pi Files Review

Pi Files Review is a read-only Oh My Pi extension for reviewing project files and Git changes inside the current OMP terminal session. It provides a keyboard-driven project tree and a selected-file diff or content preview without replacing the editor or leaving OMP.

## Prerequisites

- Oh My Pi (OMP) 18.0.11 or newer
- Bun 1.3.14 or newer
- Git installed and available on `PATH` for Git mode

The extension targets the OMP 18.0.11 interactive TUI in Windows PowerShell and Windows Terminal. Git repositories without an initial commit are supported. A non-Git directory uses the read-only filesystem fallback.

## Install

Install the published Git tag through OMP:

```powershell
omp plugin install github:gwlzhf/pi-lazygit#v0.1.1
```

When replacing an installation that came from another source, uninstall it first so OMP can register the Git package cleanly:

```powershell
omp plugin uninstall pi-lazygit
omp plugin install github:gwlzhf/pi-lazygit#v0.1.1
```

Restart OMP after installation so the plugin is loaded and the session baseline is established.

For a one-run development session without installing the plugin, run this from the repository root:

```powershell
omp --extension ./src/index.ts
```

## Open the panel

Within an interactive OMP session, use either entry point:

- `/files`
- `Alt+Q`

Both open the same review panel. Only one panel can be open at a time. Headless, print, RPC, and ACP invocations do not mount the panel; an attempted invocation reports that the interactive UI is unavailable.

At wide terminal widths the project tree and preview appear side by side. At narrow widths, the tree and preview use a single pane.

The panel opens as a fullscreen overlay on the terminal's alternate screen, so the OMP transcript stays intact underneath and the terminal reports mouse events to the panel. While the panel is open, the terminal's own text selection is unavailable.

## Layout

`Tab` and `Shift+Tab` move the operating focus between the project tree and the preview. In the side-by-side layout both panes stay visible and only the focused pane consumes keys; in the single-pane layout the focused pane is the one shown.

The tree pane width is adjustable. Drag the divider between the panes with the left mouse button, or use `[` / `]` (also `Ctrl+Left` / `Ctrl+Right`) to change it one column at a time. The width is capped at 30% of the panel interior and never falls below 12 columns, unless the 30% cap is itself below 12 columns, in which case the cap wins. The chosen width is kept as a ratio, so it survives terminal resizes; it resets to the 30% default the next time the panel opens.

The mouse wheel moves the selection in the tree pane and scrolls the preview pane, following the pointer in the side-by-side layout and the focused pane in the single-pane layout.

## Keys

### Project tree

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move the selection |
| `j` / `k` | Move the selection down/up |
| `Left` / `Right` | Collapse/expand a directory |
| `h` / `l` | Collapse/expand a directory |
| `Enter` | Toggle a directory, or open/focus the selected file preview |
| `Tab` / `Shift+Tab` | Move focus to the preview |
| `[` / `]` or `Ctrl+Left` / `Ctrl+Right` | Narrow/widen the tree pane |
| `m` | Show modified files |
| `a` | Show all visible files |
| `s` | Toggle workspace/session scope |
| `r` | Refresh status, tree, summary, and selected preview |
| `Esc` | Close the panel from the tree |
| configured OMP `app.interrupt` key | Close the panel from the tree |

### Preview

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one line |
| `j` / `k` | Scroll one line down/up |
| `PageUp` / `PageDown` | Scroll one page |
| `Home` / `End` | Jump to the start/end |
| `Tab` / `Shift+Tab` | Return focus to the project tree |
| `[` / `]` or `Ctrl+Left` / `Ctrl+Right` | Narrow/widen the tree pane |
| `Left` or `h` | Return focus to the project tree |
| `Esc` | Return focus to the project tree |
| configured OMP `app.interrupt` key | Return to the tree; invoke it again from the tree to close |

Selecting a file begins loading its preview immediately. `Enter` transfers focus to the preview.

## Review modes and scopes

The view mode and change scope are independent:

- **Modified mode** (`m`) shows only files changed in the active scope.
- **All-files mode** (`a`) shows the complete Git-visible project tree. Status markers and totals still reflect the active scope.
- **Workspace scope** shows current working-tree changes relative to `HEAD`, including staged and unstaged changes.
- **Session scope** (`s`) shows changes that differ from the repository snapshot captured for the current OMP session.

The active repository baseline is captured at `session_start`, before the panel opens. A repository first visited later in the same OMP session receives a baseline on first access. Baselines live only in memory and are cleared on `session_shutdown`, so restarting OMP starts a new comparison period.

Session scope is temporal attribution, not Agent attribution. Any edit made after the baseline counts, including edits made by external programs, other terminals, or people. A file restored to its baseline state disappears from session scope.

Tracked files display a unified `HEAD`-to-working-tree diff that combines staged and unstaged changes. Deleted files display their deletion diff. Untracked and unchanged text files display read-only, line-numbered content. Binary files display metadata instead of raw bytes.

## Non-Git directories

Outside a Git repository, the panel becomes a read-only filesystem browser rooted at OMP's current working directory. It includes ordinary entries except `.git`. Git status, modified mode, and workspace/session scope are unavailable because there is no Git baseline. Git ignore rules do not apply in filesystem fallback mode.

## Limits

To keep the OMP session responsive:

- Preview source or diff input is limited to 1 MiB per file.
- A preview renders at most 5,000 logical lines.
- Non-Git filesystem traversal stops after 20,000 entries.

The panel displays a truncation state when a limit is reached. Git all-files mode includes tracked and untracked/non-ignored paths, excludes ignored paths, and never traverses `.git` internals.

## Scope and safety

Pi Files Review is intentionally read-only. It does not edit files, stage changes, apply or revert hunks, commit, branch, or otherwise mutate the repository. It also does not claim that an Agent produced every change shown in session scope.
