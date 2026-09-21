# Pi Files Review

Pi Files Review is a review panel for Oh My Pi (OMP) and OpenCode. It provides a keyboard- and mouse-driven project tree and a selected-file diff or content preview without replacing the editor or leaving the host terminal. Review itself is read-only; the one repository-mutating action is switching to a local branch, which is always explicit.

## Prerequisites

- Oh My Pi (OMP) `>=18.0.11 <19`
- OpenCode `>=1.18.31 <2` (for the native TUI route)
- Bun 1.3.14 or newer
- Git installed and available on `PATH` for Git mode

The extension targets the OMP 18.0.11 interactive TUI and OpenCode 1.18.31+ in Windows PowerShell and Windows Terminal. Git repositories without an initial commit are supported. A non-Git directory uses the read-only filesystem fallback.

## Install

Install the published Git tag through OpenCode:

```powershell
opencode plugin github:gwlzhf/opencode-lazygit#v0.4.2
```

The plugin is also installable by adding the same Git reference to the OpenCode `tui.json` plugin configuration:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "github:gwlzhf/opencode-lazygit#v0.4.2"
  ]
}
```

For a local checkout, point the same configuration at the package path instead:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "C:\\path\\to\\opencode-lazygit"
  ]
}
```

Restart OpenCode after changing its plugin configuration. The package exposes the host-native `./tui` entrypoint; it does not require the OMP runtime.

For a local OpenCode development session, use the package path in `tui.json` and launch OpenCode from the project directory.

## Open the panel

Within an interactive OMP or OpenCode session, use either entry point:

- `/files`
- `Alt+Q`

On OMP, `/files` and `Alt+Q` open the same fullscreen review panel. On OpenCode, both entry points invoke the same command (`pi-lazygit.files.open`) and open the native review route (`pi-lazygit.files`). Only one panel can be open at a time. Headless, print, RPC, and ACP invocations do not mount the panel; an attempted invocation reports that the interactive UI is unavailable.

OMP opens its fullscreen overlay on the terminal's alternate screen. OpenCode mounts the equivalent native OpenTUI route, so both hosts keep their own navigation, focus, mouse, and theme behavior.

At wide terminal widths the project tree and preview appear side by side. At narrow widths, or with the tree collapsed, the tree and preview use a single pane.

Both hosts frame the panel with three chrome rows. The top row is an overview header: on the left the active review (`Diff working tree`, `Diff session`, `Project files`, `History`, or `Switch branch`), on the right the current branch — or `detached <short-oid>` — followed by the visible file count. Below it the pane-title row names the left pane and the selected file; on a diff preview the file is followed by its `+N -N` line summary, taken from the same status inspection that produces the totals, and omitted entirely when the file has no summary. The bottom row carries the status text and the compact key hints for the current mode.

The terminal's own text selection is unavailable while the panel is open; the preview pane provides its own (see [Copying preview text](#copying-preview-text)).

## Layout

`Tab` and `Shift+Tab` move the operating focus between the project tree and the preview. In the side-by-side layout both panes stay visible and only the focused pane consumes keys; in the single-pane layout the focused pane is the one shown.

`Right` / `l` and `Left` / `h` move focus the same way, one pane at a time: from a selected file `Right` enters the preview, and `Left` returns to the tree. On a directory `Right` keeps its tree meaning — expand it, or descend into an already expanded one — because a directory has no preview to enter. In the side-by-side layout a left click anywhere in the preview also takes focus.

The tree pane width is adjustable in the side-by-side layout. Drag the divider between the panes with the left mouse button, or use `[` / `]` (also `Ctrl+Left` / `Ctrl+Right`) to change it one column at a time. The width is capped at 30% of the panel interior and never falls below 12 columns, unless the 30% cap is itself below 12 columns, in which case the cap wins.

The single-pane layout has no divider to move — the visible pane spans the panel — so the width keys do nothing there and leave the stored width alone, rather than changing it for the next terminal wide enough to show both panes. The footer omits the `[ ] width` hint whenever the panel is showing a single pane, including a collapsed tree.

OMP stores width, collapsed state, syntax theme, and diff view settings in `pi-lazygit.json` in the OMP agent directory (`~/.omp` unless overridden). OpenCode stores the same schema in its host KV store under `pi-lazygit.panel-settings`. These settings survive panel closes and host restarts. Width is stored as a ratio of the panel interior. Rapid changes are coalesced into a single OMP file write; OpenCode KV writes replace one field immediately. Unreadable, invalid, or unwritable settings fall back to the 30% width, expanded tree, Pi syntax theme, and unified 3-line diff without interrupting the session.

The mouse wheel moves the selection in the tree pane and scrolls the preview pane, following the pointer in the side-by-side layout and the focused pane in the single-pane layout.

Left-clicking a visible row in the left pane focuses that pane and selects the row. In the project tree a file click starts its preview immediately, and a directory click selects it without expanding or collapsing it — expansion stays on the keyboard. History and branch rows behave the same way: a click selects only. Clicks on the overview header, the pane-title row, the footer, the padding below the last row, and the divider select nothing; divider dragging and preview text selection keep their existing meaning.

Selected rows are painted across the full pane width using the host theme's selection colors — `selectedBg` in OMP, `backgroundElement` with `selectedListItemText` in OpenCode. Diff previews mask whole rows as well: OMP uses the theme's success and error backgrounds for added and removed lines, and OpenCode uses `diffAddedBg`, `diffRemovedBg`, and `diffContextBg` with their matching foreground tokens. In the split layout each column carries its own background through its gutter, marker, body, and padding while the unchanged side keeps the context background. Hunk and context rows keep ordinary theme colors. No color is hardcoded, and the masks change neither the visible width nor the text that a selection copies.

## Copying preview text

Drag with the left mouse button inside the preview pane to select text. The selection is painted in reverse video, spans whole rows between its first and last row, and includes the cell under the pointer. Releasing the button copies the selected text and reports, for example, `copied 3 lines` in the footer.

The copy is an OSC 52 clipboard write, so it reaches the system clipboard of the terminal you are sitting at, including across SSH. Terminals that do not implement OSC 52, or that disable it by default, ignore the write; nothing else in the panel changes. Copied lines carry the rendered text of the pane, so a selection that starts left of the code includes the line-number gutter, and trailing row padding is trimmed.

The selection is cleared by scrolling, by selecting another file, and by any change to the pane geometry — resizing or collapsing the tree, or switching the diff layout or context.

## Syntax highlighting

OMP text previews use OMP's highlighter with four palettes: Pi (default, using the active OMP theme), Catppuccin, Nord, and Tokyo Night. Press `t` from either pane to cycle them in that order. This `t` syntax-palette control is Pi-only. OpenCode uses host theme tokens and plain text previews; it does not expose Pi's tokenizer palettes. In both hosts, panel borders, status colors, and diff colors follow the active host theme. The language is detected from the file path — TypeScript, JavaScript/Node, C#, Go, C/C++, Rust, Python, Java, Kotlin, Ruby, PHP, shell, JSON, YAML, and the other languages OMP supports. Files whose language is unknown or unsupported render as plain text.

Diffs keep their per-line added/removed/hunk coloring instead of language highlighting. Preview content is sanitized before it is highlighted, so file contents can never emit their own terminal escape sequences.

## Diff views

In Git mode a tracked file's preview is a diff, and two keys control how it reads. Both work from either pane, and both are remembered across sessions.

`d` switches between the layouts:

- **Unified** (default) is Git's own single-column output.
- **Split** shows the old file on the left and the new file on the right, with each column line-numbered and marked `-` or `+`. Removals pair with the additions that replace them; where one side has no counterpart, its column is blank. File and hunk headers stay across the full width. The split layout needs at least 40 columns of preview; a narrower preview keeps the unified layout, as does a combined merge diff, which numbers more than two files per hunk.

`c` cycles how much unchanged code surrounds each change: **3** lines (default), **10**, **25**, then **full** — the entire file, with the changed lines still marked. Each press refetches the diff from Git, so the count is exact rather than reconstructed. Whole-file context still obeys the 1 MiB and 5,000-line preview limits.

The footer reports the active layout and context, for example `split diff · ctx 10`.

## Live refresh

In Git mode the panel watches the worktree and its Git metadata, so the file list, status markers, and totals follow the repository without a keypress. Edits made by the Agent, another terminal, or an external program all appear on their own.

Watching uses recursive filesystem watches on the worktree, the Git directory, and — in a linked worktree, where `.git` is a file naming its real Git directory — the shared common directory. Object writes, reflog writes, and `*.lock` files are ignored, so fetching, packing, and Git's own intermediate states do not trigger refreshes. Bursts are coalesced with a 150 ms debounce, and a refresh already in flight queues at most one successor rather than stacking.

The watch stops when the panel closes. If it cannot start, or fails later, the footer reports `watch error: …` and the panel remains usable with `F5` or `r`. Filesystem fallback mode has no watch, because there is no Git state to follow.

## Commit history

Press `g` to swap the left pane between the project tree and the commit history; press it again to return. The history lists the most recent commits as short OID and subject, and selecting an entry previews that commit's diff in the preview pane.

The commit diff obeys the same `d` and `c` keys as a file diff, so layout and context carry over between the two views. Changing the context refetches the commit from Git.

History is limited to the 200 most recent commits, and the footer reports `history truncated` when more exist. The footer reports `commit preview truncated` when a commit's diff exceeds the preview limits. `F5` or `r` reloads the history, and the selected commit is preserved across a reload when it still exists. The history view is Git-only and is unavailable in filesystem fallback mode.

## Switching branches

Press `b` to swap the left pane for the list of local branches; press `b` again, or `Esc`, to return to the project tree without changing anything. Move the selection with `n` / `p` or `Up` / `Down`, and press `Enter` to switch to the selected branch. The current branch is marked, and `Enter` on it simply returns to the files view without running Git.

**Switching a branch writes to your repository.** It is the only operation in this plugin that does. Everything else remains read-only.

The switch runs the equivalent of `git switch --no-guess <branch>` as an argument vector — no shell command is built, and the name always comes from your own local refs, revalidated immediately before execution. The plugin never fetches, never stashes, never forces, and never creates, renames, or deletes a ref. Only local branches are listed: remote branches, tags, and arbitrary revisions cannot be selected.

A dirty worktree is left to Git's own safety rules. If your changes carry cleanly to the target branch, Git switches and keeps them. If the switch would overwrite them, Git refuses, your files are untouched, and the sanitized error stays visible in the branch list — the plugin does not retry, stash, or resolve anything on your behalf. Clicking a branch row only selects it, so no single click can move your `HEAD`.

After a successful switch the panel returns to the files view, clears selection state belonging to the old branch, refreshes under the new `HEAD`, and only then restarts the worktree watch. A failed switch keeps you in the branch list with the selection intact.

Session baselines are per branch. Each branch, detached checkout, or unborn branch gets its own baseline on first visit, so switching branches is not misread as a session-sized edit, and returning to a branch restores its own comparison point. Branch listing and switching are Git-only and unavailable in filesystem fallback mode. Both hosts behave identically here.

## Keys

`?` opens a full list of every shortcut, grouped by navigation, review, layout, and mouse. It leaves the selection, preview, and branch state untouched; `?` or `Esc` closes it, and `Esc` closes the help before anything else.

All controls below apply to OMP and OpenCode except the `t` syntax-palette control, which is Pi-only, and the configured OMP `app.interrupt` key. In OpenCode, `Esc` from the preview focuses the tree; `Esc` from the tree or history returns home.

### Project tree

| Key | Action |
| --- | --- |
| `n` / `p` | Move the selection to the next/previous row |
| `Up` / `Down` | Move the selection |
| `Left` / `h` | Collapse a directory, or move to its parent |
| `Right` / `l` | Expand or descend a directory; move focus to the preview from a file |
| `Enter` | Toggle a directory, or open/focus the selected file preview |
| `Tab` / `Shift+Tab` | Move focus to the preview |
| `[` / `]` or `Ctrl+Left` / `Ctrl+Right` | Narrow/widen the tree pane |
| `\` or `Ctrl+B` | Collapse the tree pane |
| `t` (Pi only) | Cycle Pi, Catppuccin, Nord, and Tokyo Night syntax themes |
| `d` | Switch the diff preview between unified and split columns |
| `c` | Cycle the diff context: 3, 10, 25, full file |
| `m` | Show modified files |
| `a` | Show all visible files |
| `s` | Toggle workspace/session scope |
| `g` | Switch the left pane between the project tree and the commit history |
| `b` | Switch the left pane to the local branch list |
| `?` | Show every shortcut |
| `F5` / `r` | Refresh Git status, change list, summary, and selected diff or code |
| Left click | Focus the tree and select the clicked row |
| `Esc` | Close the OMP panel, or return home in OpenCode |
| configured OMP `app.interrupt` key | Close the panel from the tree (OMP only) |

`j` and `k` no longer move the tree selection; they scroll the preview. Use `n` / `p` or `Up` / `Down` here.

### Preview

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one line |
| `j` / `k` | Scroll one line down/up |
| `PageUp` / `PageDown` | Scroll one page |
| `Home` / `End` | Jump to the start/end |
| `Tab` / `Shift+Tab` | Return focus to the project tree |
| `[` / `]` or `Ctrl+Left` / `Ctrl+Right` | Narrow/widen the tree pane |
| `\` or `Ctrl+B` | Collapse/restore the tree pane |
| `t` (Pi only) | Cycle Pi, Catppuccin, Nord, and Tokyo Night syntax themes |
| `d` | Switch the diff preview between unified and split columns |
| `c` | Cycle the diff context: 3, 10, 25, full file |
| `g` | Switch the left pane between the project tree and the commit history |
| `b` | Switch the left pane to the local branch list |
| `?` | Show every shortcut |
| `F5` / `r` | Refresh Git status, change list, summary, and selected diff or code |
| `Left` or `h` | Return focus to the project tree |
| Left-button drag | Select preview text; release copies it |
| `Esc` | Return focus to the project tree |
| configured OMP `app.interrupt` key | Return to the tree; invoke it again from the tree to close (OMP only) |

Selecting a file begins loading its preview immediately. `Enter` transfers focus to the preview.

Press `F5` from either pane to reload repository status and the selected file together. The refreshed tree preserves the selected path when it still exists; otherwise it moves to the nearest surviving row.

### Commit history

Replaces the project tree keys while the history is shown (`g`).

| Key | Action |
| --- | --- |
| `n` / `p` | Move the commit selection to the next/previous row |
| `Up` / `Down` | Move the commit selection |
| `Enter` or `Right` / `l` | Focus the commit diff preview |
| `g` | Return to the project tree |
| `b` | Switch the left pane to the local branch list |
| `?` | Show every shortcut |
| `F5` / `r` | Reload the commit history |
| Left click | Select the clicked commit |
| `Esc` | Close the OMP panel, or return home in OpenCode |

### Branches

Replaces the project tree keys while the branch list is shown (`b`).

| Key | Action |
| --- | --- |
| `n` / `p` | Move the branch selection to the next/previous row |
| `Up` / `Down` | Move the branch selection |
| `Enter` | Switch to the selected branch; a no-op on the current branch |
| `b` / `Esc` | Return to the project tree without switching |
| `?` | Show every shortcut |
| Left click | Select the clicked branch; it never switches |

## Review modes and scopes

The view mode and change scope are independent:

- **Modified mode** (`m`) shows only files changed in the active scope.
- **All-files mode** (`a`) shows the complete Git-visible project tree. Status markers and totals still reflect the active scope.
- **Workspace scope** shows current working-tree changes relative to `HEAD`, including staged and unstaged changes.
- **Session scope** (`s`) shows changes that differ from the repository snapshot captured for the current host session.

Each host keeps its repository baseline in memory. OMP captures it at `session_start` before the panel opens; a repository first visited later in that OMP session receives a baseline on first access. OpenCode prepares the current directory's baseline once during plugin activation when paths are ready, or before the first successful open if activation happens early. Baselines are cleared when the host session shuts down, so restarting OMP or OpenCode starts a new comparison period.

Session scope is temporal attribution, not Agent attribution. Any edit made after the baseline counts, including edits made by external programs, other terminals, or people. A file restored to its baseline state disappears from session scope.

Tracked files display a `HEAD`-to-working-tree diff that combines staged and unstaged changes, in the layout and context selected with `d` and `c`. Deleted files display their deletion diff. Untracked and unchanged text files display read-only, line-numbered content. Binary files display metadata instead of raw bytes.

## Non-Git directories

Outside a Git repository, the panel becomes a read-only filesystem browser rooted at the host's current working directory. It includes ordinary entries except `.git`. Git status, modified mode, and workspace/session scope are unavailable because there is no Git baseline. Git ignore rules do not apply in filesystem fallback mode.

## Limits

To keep the host session responsive:

- Preview source or diff input is limited to 1 MiB per file.
- A preview renders at most 5,000 logical lines.
- Non-Git filesystem traversal stops after 20,000 entries.
- The commit history lists at most the 200 most recent commits.

The panel displays a truncation state when a limit is reached. Git all-files mode includes tracked and untracked/non-ignored paths, excludes ignored paths, and never traverses `.git` internals.

## Scope and safety

Pi Files Review is read-only in both hosts except for one explicit action: switching to a local branch with `Enter` in the branch list (see [Switching branches](#switching-branches)). It does not edit files, stage changes, apply or revert hunks, commit, fetch, stash, force, or create, rename, or delete any ref. It also does not claim that an Agent produced every change shown in session scope.
