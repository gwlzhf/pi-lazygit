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
omp plugin install github:gwlzhf/pi-lazygit#v0.2.1
```

When replacing an installation that came from another source, uninstall it first so OMP can register the Git package cleanly:

```powershell
omp plugin uninstall pi-lazygit
omp plugin install github:gwlzhf/pi-lazygit#v0.2.1
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

At wide terminal widths the project tree and preview appear side by side. At narrow widths, or with the tree collapsed, the tree and preview use a single pane.

The panel opens as a fullscreen overlay on the terminal's alternate screen, so the OMP transcript stays intact underneath and the terminal reports mouse events to the panel. The terminal's own text selection is unavailable while the panel is open; the preview pane provides its own (see [Copying preview text](#copying-preview-text)).

## Layout

`Tab` and `Shift+Tab` move the operating focus between the project tree and the preview. In the side-by-side layout both panes stay visible and only the focused pane consumes keys; in the single-pane layout the focused pane is the one shown.

`Right` / `l` and `Left` / `h` move focus the same way, one pane at a time: from a selected file `Right` enters the preview, and `Left` returns to the tree. On a directory `Right` keeps its tree meaning — expand it, or descend into an already expanded one — because a directory has no preview to enter. In the side-by-side layout a left click anywhere in the preview also takes focus.

The tree pane width is adjustable. Drag the divider between the panes with the left mouse button, or use `[` / `]` (also `Ctrl+Left` / `Ctrl+Right`) to change it one column at a time. The width is capped at 30% of the panel interior and never falls below 12 columns, unless the 30% cap is itself below 12 columns, in which case the cap wins.

`\` (also `Ctrl+B`) collapses the tree pane so the preview uses the full panel width, and restores it again. While the tree is collapsed the preview holds focus and every key routes to it; `\`, `Ctrl+B`, `Tab`, `Esc`, `Left`/`h`, and `]` all bring the tree back and return focus to it. `Esc` therefore takes two presses to close the panel from a collapsed tree: one to reveal it, one to close.

The width, collapsed state, syntax theme, and diff view settings are stored in `pi-lazygit.json` in the OMP agent directory (`~/.omp` unless overridden), so they survive panel closes and OMP restarts. Width is stored as a ratio of the panel interior. Rapid changes are coalesced into a single write; unreadable, invalid, or unwritable settings fall back to the 30% width, expanded tree, Pi syntax theme, and unified 3-line diff without interrupting the session.

The mouse wheel moves the selection in the tree pane and scrolls the preview pane, following the pointer in the side-by-side layout and the focused pane in the single-pane layout.

## Copying preview text

Drag with the left mouse button inside the preview pane to select text. The selection is painted in reverse video, spans whole rows between its first and last row, and includes the cell under the pointer. Releasing the button copies the selected text and reports, for example, `copied 3 lines` in the footer.

The copy is an OSC 52 clipboard write, so it reaches the system clipboard of the terminal you are sitting at, including across SSH. Terminals that do not implement OSC 52, or that disable it by default, ignore the write; nothing else in the panel changes. Copied lines carry the rendered text of the pane, so a selection that starts left of the code includes the line-number gutter, and trailing row padding is trimmed.

The selection is cleared by scrolling, by selecting another file, and by any change to the pane geometry — resizing or collapsing the tree, or switching the diff layout or context.

## Syntax highlighting

Text previews use OMP's highlighter with four palettes: Pi (default, using the active OMP theme), Catppuccin, Nord, and Tokyo Night. Press `t` from either pane to cycle them in that order. The selected palette affects code syntax only; panel borders, status colors, and diff colors continue to use the active OMP theme. The language is detected from the file path — TypeScript, JavaScript/Node, C#, Go, C/C++, Rust, Python, Java, Kotlin, Ruby, PHP, shell, JSON, YAML, and the other languages OMP supports. Files whose language is unknown or unsupported render as plain text.

Diffs keep their per-line added/removed/hunk coloring instead of language highlighting. Preview content is sanitized before it is highlighted, so file contents can never emit their own terminal escape sequences.

## Diff views

In Git mode a tracked file's preview is a diff, and two keys control how it reads. Both work from either pane, and both are remembered across sessions.

`d` switches between the layouts:

- **Unified** (default) is Git's own single-column output.
- **Split** shows the old file on the left and the new file on the right, with each column line-numbered and marked `-` or `+`. Removals pair with the additions that replace them; where one side has no counterpart, its column is blank. File and hunk headers stay across the full width. The split layout needs at least 40 columns of preview; a narrower preview keeps the unified layout, as does a combined merge diff, which numbers more than two files per hunk.

`c` cycles how much unchanged code surrounds each change: **3** lines (default), **10**, **25**, then **full** — the entire file, with the changed lines still marked. Each press refetches the diff from Git, so the count is exact rather than reconstructed. Whole-file context still obeys the 1 MiB and 5,000-line preview limits.

The footer reports the active layout and context, for example `split diff · ctx 10`.

## Keys

### Project tree

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move the selection |
| `j` / `k` | Move the selection down/up |
| `Left` / `h` | Collapse a directory, or move to its parent |
| `Right` / `l` | Expand or descend a directory; move focus to the preview from a file |
| `Enter` | Toggle a directory, or open/focus the selected file preview |
| `Tab` / `Shift+Tab` | Move focus to the preview |
| `[` / `]` or `Ctrl+Left` / `Ctrl+Right` | Narrow/widen the tree pane |
| `\` or `Ctrl+B` | Collapse the tree pane |
| `t` | Cycle Pi, Catppuccin, Nord, and Tokyo Night syntax themes |
| `d` | Switch the diff preview between unified and split columns |
| `c` | Cycle the diff context: 3, 10, 25, full file |
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
| `\` or `Ctrl+B` | Collapse/restore the tree pane |
| `t` | Cycle Pi, Catppuccin, Nord, and Tokyo Night syntax themes |
| `d` | Switch the diff preview between unified and split columns |
| `c` | Cycle the diff context: 3, 10, 25, full file |
| `Left` or `h` | Return focus to the project tree |
| Left-button drag | Select preview text; release copies it |
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

Tracked files display a `HEAD`-to-working-tree diff that combines staged and unstaged changes, in the layout and context selected with `d` and `c`. Deleted files display their deletion diff. Untracked and unchanged text files display read-only, line-numbered content. Binary files display metadata instead of raw bytes.

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
