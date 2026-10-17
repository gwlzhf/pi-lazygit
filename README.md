# Pi Files Review

Pi Files Review is an Oh My Pi extension for reviewing project files and Git changes inside the current OMP terminal session. It opens with a keyboard- and mouse-driven list of changed files and a selected-file diff or content preview; press `v` for the directory tree. Review is read-only until you explicitly invoke a write action: commit selected workspace paths, amend the current `HEAD` subject, push a reviewed upstream plan, or switch to a local branch.

## Prerequisites

- Oh My Pi (OMP) 18.3.1 or newer (native `/btw` history required)
- Bun 1.3.14 or newer
- Git installed and available on `PATH` for Git mode

The extension targets the OMP 18.3.1 interactive TUI in Windows PowerShell and Windows Terminal. Git repositories without an initial commit are supported. Both Git and non-Git projects support read-only directory browsing.

## Install

Install the published Git tag through OMP:

```powershell
omp plugin install github:gwlzhf/pi-lazygit#v0.9.6
```

When replacing an installation that came from another source, uninstall it first so OMP can register the Git package cleanly:

```powershell
omp plugin uninstall pi-lazygit
omp plugin install github:gwlzhf/pi-lazygit#v0.9.6
```

Restart OMP after installation so the plugin is loaded and the session baseline is established.

The plugin does not declare or download the OMP SDK. It uses the `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` modules bundled with the OMP you have installed, so installing it never pulls a separate or newer copy of those packages into `node_modules`. The `devDependencies` entries pin the same version (18.3.1) only for developing and testing this repository; a source checkout still needs `bun install` for development.

This dependency change applies to packages built from the updated source. Existing installations and previously published tags are unchanged; install a newly built package to use it.

For a one-run development session without installing the plugin, run this from the repository root:

```powershell
omp --extension ./src/index.ts
```

## Open the panel

Within an interactive OMP session, use either entry point:

- `/files`
- `Alt+Q`

Both open the same review panel. Only one panel can be open at a time. Headless, print, RPC, and ACP invocations do not mount the panel; an attempted invocation reports that the interactive UI is unavailable.

At wide terminal widths the file list (or directory tree) and preview appear side by side. At narrow widths, or with the left pane collapsed, the list/tree and preview use a single pane. Non-Git directories open in the directory tree.

The panel fills the terminal without a separate input box. The top row is an overview header: on the left the active review (`Diff working tree`, `Diff session`, `Project files`, `History`, or `Switch branch`), on the right the current branch — or `detached <short-oid>` — followed by the visible file count. Below it the pane-title row names the left pane and the selected file; on a diff preview the file is followed by its `+N -N` line summary, taken from the same status inspection that produces the totals, and omitted entirely when the file has no summary. The footer carries status and key hints.

The panel opens as a fullscreen overlay on the terminal's alternate screen, so the OMP transcript stays intact underneath and the terminal reports mouse events to the panel. The terminal's own text selection is unavailable while the panel is open; the preview pane provides its own (see [Copying preview text](#copying-preview-text)).

## Layout

`Tab` and `Shift+Tab` move the operating focus between the file list/tree and the preview. In the side-by-side layout both panes stay visible and only the focused pane consumes keys; in the single-pane layout the focused pane is the one shown.

`Right` / `l` and `Left` / `h` move focus one pane at a time: from a selected file `Right` enters the preview, and `Left` returns to the file list or tree. On a directory `Right` expands it, or descends into an already expanded one. In the side-by-side layout a left click anywhere in the preview also takes focus.

The left pane opens at 30% of the panel interior. Drag its divider with the left mouse button, or use `[` / `]` (also `Ctrl+Left` / `Ctrl+Right`) to change it one column at a time. There is no fixed percentage cap: the pane can grow until 40 preview columns remain, and cannot shrink below 12 columns.

The single-pane layout has no divider to move — the visible pane spans the panel — so the width keys do nothing there and leave the stored width alone, rather than changing it for the next terminal wide enough to show both panes. The footer omits the `[ ] width` hint whenever the panel is showing a single pane, including a collapsed tree.

`\` (also `Ctrl+B`) collapses the tree pane so the preview uses the full panel width, and restores it again. While the tree is collapsed the preview holds focus and every key routes to it; `\`, `Ctrl+B`, `Tab`, `Esc`, `Left`/`h`, and `]` all bring the tree back and return focus to it. `Esc` therefore takes two presses to close the panel from a collapsed tree: one to reveal it, one to close.

The width, collapsed state, syntax theme, diff view, and diff mask opacity settings are stored in `pi-lazygit.json` in the OMP agent directory (`~/.omp` unless overridden), so they survive panel closes and OMP restarts. Width is stored as a ratio of the panel interior. Rapid changes are coalesced into a single write; unreadable, invalid, or unwritable settings fall back to the 30% width, expanded tree, Pi syntax theme, unified 3-line diff, and the default mask opacity without interrupting the session.

The mouse wheel moves the selection in the left pane and scrolls the preview pane, following the pointer in the side-by-side layout and the focused pane in the single-pane layout.

Left-clicking a visible row in the left pane focuses that pane and selects the row. In the project tree a file click starts its preview immediately, and a directory click selects it without expanding or collapsing it — expansion stays on the keyboard. History and branch rows behave the same way: a click selects only. The footer's `P push current branch` action is also clickable; other footer positions and clicks on the overview header, pane-title row, padding below the last row, and divider select nothing. Divider dragging and preview text selection keep their existing meaning.

Selected rows are painted across the full pane width using the active OMP theme's selection background. Runtimes older than the `Theme.fgOnBg` helper fall back to a plain foreground over the same background token instead of failing to render. Diff previews mask whole rows as well: added lines use Claude Code's green background, removed lines its red background, and in the split layout each column carries its own background through its gutter, marker, body, and padding while the unchanged side keeps the context background. These darker masks change neither the visible width nor the text that a selection copies; changed-line foregrounds use the deeper red/green palette described below.

## Copying preview text

Drag with the left mouse button inside the preview pane to select text. The selection is painted in reverse video, spans whole rows between its first and last row, and includes the cell under the pointer. Releasing the button copies the selected text and reports, for example, `copied 3 lines` in the footer.

The copy is an OSC 52 clipboard write, so it reaches the system clipboard of the terminal you are sitting at, including across SSH. Terminals that do not implement OSC 52, or that disable it by default, ignore the write; nothing else in the panel changes. Copied lines carry the rendered text of the pane, so a selection that starts left of the code includes the line-number gutter, and trailing row padding is trimmed.

The selection is cleared by scrolling, by selecting another file, and by any change to the pane geometry — resizing or collapsing the tree, or switching the diff layout or context.

## `/btw` history while reviewing

Press `i` in either review pane to open OMP's **native `/btw` history** over the review. Its left pane lists side conversations; its right pane displays the selected conversation and answers. `Up`/`Down` choose a topic; `Tab` or `Right`/`Left` switch between the list and details. Press `f` or `Enter` on a topic to use OMP's own follow-up input. `Esc` closes history and returns to the same review panel. The review does not render an input box or an answer of its own.

The shortcut opens history without submitting a question or injecting the selected diff or a file mention. Your existing main-editor draft remains unchanged. To start a new topic, leave review and use `/btw <question>` in the main OMP editor; then return to review and press `i` to browse it.

## Syntax highlighting

Text previews use OMP's highlighter with four palettes: Pi (default, using the active OMP theme), Catppuccin, Nord, and Tokyo Night. Press `t` from either pane to cycle them in that order. The selected palette affects code syntax only; panel borders and status colors continue to use the active OMP theme. The language is detected from the file path — TypeScript, JavaScript/Node, C#, Go, C/C++, Rust, Python, Java, Kotlin, Ruby, PHP, shell, JSON, YAML, and the other languages OMP supports. Files whose language is unknown or unsupported render as plain text.

Diffs keep per-line colors instead of language highlighting: additions and removals are shown with Claude Code's default diff masks (dark green and dark red backgrounds, lighter shades on light themes) over the terminal's default foreground. Preview content is sanitized before it is highlighted, so file contents can never emit their own terminal escape sequences.

## Diff views

In Git mode a tracked file's preview is a diff, and two keys control how it reads. Both work from either pane, and both are remembered across sessions.

`d` switches between the layouts:

- **Unified** (default) is Git's own single-column output.
- **Split** shows the old file on the left and the new file on the right, with each column line-numbered and marked `-` or `+`. Removals pair with the additions that replace them; where one side has no counterpart, its column is blank. File and hunk headers stay across the full width. The split layout needs at least 40 columns of preview; a narrower preview keeps the unified layout, as does a combined merge diff, which numbers more than two files per hunk.

Long diff lines wrap within the preview instead of being cut off. In split layout, each side wraps independently and keeps its continuation aligned with the opposite side. Scrolling counts these visual rows, including after a resize.

`c` cycles how much unchanged code surrounds each change: **3** lines (default), **10**, **25**, then **full** — the entire file, with the changed lines still marked. Each press refetches the diff from Git, so the count is exact rather than reconstructed. Whole-file context still obeys the 1 MiB and 5,000-line preview limits.

The footer reports the active layout and context, for example `split diff · ctx 10`.

Diff change masks cover the full rendered row in unified view. In split view, each changed side's mask covers that entire side's row through its gutter, marker, body, and padding, while the unchanged side keeps the context background. The masks use Claude Code's default green/red backgrounds at 100% opacity; press `-` or `=` to lower or raise their opacity in 10% steps. The selected opacity is persisted with the other review settings.

## Live refresh

In Git mode the panel watches the worktree and its Git metadata, so the file list, status markers, and totals follow the repository without a keypress. Edits made by the Agent, another terminal, or an external program all appear on their own.

Watching uses recursive filesystem watches on the worktree, the Git directory, and — in a linked worktree, where `.git` is a file naming its real Git directory — the shared common directory. Object writes, reflog writes, and `*.lock` files are ignored, so fetching, packing, and Git's own intermediate states do not trigger refreshes. Bursts are coalesced with a 150 ms debounce, and a refresh already in flight queues at most one successor rather than stacking.

Review queries do not refresh the index on disk: Git optional locks and `diff.autoRefreshIndex` are disabled for queries. The baseline index fingerprint is a SHA-256 hash of `git ls-files --stage -z`, covering staged modes, object IDs, merge stages, and paths without calling the index-writing `git write-tree`. Commit/amend still write normally and refresh the panel afterward; idle review no longer creates its own index events.

The watch stops when the panel closes. If it cannot start, or fails later, the footer reports `watch error: …` and the panel remains usable with `F5` or `r`. Filesystem fallback mode has no watch, because there is no Git state to follow.

## Commit history

Press `g` to swap the file list/tree for the commit history; press it again to return. The history lists the most recent commits as short OID and subject, and selecting an entry previews that commit's diff in the preview pane.

The commit diff obeys the same `d` and `c` keys as a file diff, so layout and context carry over between the two views. Changing the context refetches the commit from Git.

History is limited to the 200 most recent commits, and the footer reports `history truncated` when more exist. The footer reports `commit preview truncated` when a commit's diff exceeds the preview limits. `F5` or `r` reloads the history, and the selected commit is preserved across a reload when it still exists. The history view is Git-only and is unavailable in filesystem fallback mode.

## Switching branches

Press `b` to swap the left pane for the list of local branches; press `b` again, or `Esc`, to return to the file list/tree without changing anything. Move the selection with `n` / `p` or `Up` / `Down`, and press `Enter` to switch to the selected branch. The current branch is marked, and `Enter` on it simply returns to the files view without running Git.

**Switching a branch writes to your repository**, as do the explicit commit, amend, and push actions described below. These actions can update local/remote branch refs as part of normal Git behavior; the panel offers no separate branch/tag/ref creation, renaming, or deletion controls, and never force-pushes, fetches, or stashes.

The switch runs the equivalent of `git switch --no-guess <branch>` as an argument vector — no shell command is built, and the name always comes from your own local refs, revalidated immediately before execution. No force operation is available. Only local branches are listed: remote branches, tags, and arbitrary revisions cannot be selected.

A dirty worktree is left to Git's own safety rules. If your changes carry cleanly to the target branch, Git switches and keeps them. If the switch would overwrite them, Git refuses, your files are untouched, and the sanitized error stays visible in the branch list — the plugin does not retry, stash, or resolve anything on your behalf. Clicking a branch row only selects it, so no single click can move your `HEAD`.

After a successful switch the panel returns to the files view, clears selection state belonging to the old branch, refreshes under the new `HEAD`, and only then restarts the worktree watch. A failed switch keeps you in the branch list with the selection intact.

Session baselines are per branch. Each branch, detached checkout, or unborn branch gets its own baseline on first visit, so switching branches is not misread as a session-sized edit, and returning to a branch restores its own comparison point. Branch listing and switching are Git-only and unavailable in filesystem fallback mode.



## Commit, amend, and push

In the flat change list, `space` toggles the current file, `x` inverts the current file's selection, and `A` toggles all visible changes. Committable tracked changes (`Modified files`) default to selected; untracked changes (`No version files`) default to unselected and can be selected manually. Refresh preserves manual choices; scope changes and post-commit resets apply these defaults again. Selection is held only in memory and is never persisted across sessions. A selection in session scope cannot be committed: session scope attributes changes since the OMP session baseline, while Git path-limited commits cannot isolate only those later edits.

`Enter` in the workspace change list starts commit: message → dry-run → `y` confirm. Git stages selected paths in batches of 200; the final path-limited commit still passes the complete selected path list, so an exceptionally large selection can exceed the platform's command-line limit. Dry-run stages those selected paths before showing its report; cancelling confirmation leaves them staged. `Ctrl+N` toggles `--no-verify` for commit/amend.

In commit history, `u` edits the subject of `HEAD` only; the existing commit body is retained. Amend is unavailable for older history entries and is blocked for an unborn/detached `HEAD` or a dirty index. An amended commit already published upstream cannot be force-pushed.

Press `P` in the files, history, or branches view—or click `P push current branch` at the start of the footer—to review a push plan for the checked-out branch. In the branches view, the selected row does not change the push target. The first `y` advances to a separate write confirmation; ordinary branches require `w`, while protected branches require typing the exact full branch name and pressing `Enter`. `main` and `master` are always protected; `protectedBranches` in `pi-lazygit.json` adds protected names. A push with remote commits ahead is blocked. A branch without an upstream is rejected; configure one first with `git push -u <remote> <branch>`. Push targets the reviewed upstream and rejects a stale plan; multiple push URLs and unexpected tag/transport behavior fail closed. It never uses force.

Ahead/behind counts use the last known local remote-tracking refs; this panel does not fetch. Fetch outside the panel to refresh those counts. Git still rejects a non-fast-forward push if the remote changed after the last fetch.

### Reverting changes

`R` in the workspace change list offers to discard changes. The hot key only describes what would happen — it never writes. A second, distinct `y` in the confirmation is what reaches the repository, and `n` or `Esc` cancels it.

It covers, in order: **every ticked file** — the `space` selection may be many files, and they are discarded together in one confirmed action; failing that, the file under the cursor. Session scope has no revert.

A tracked change is restored to the version in `HEAD`, including the index, so a staged edit is unstaged rather than half-reverted. A deleted file comes back from `HEAD`. A file that no commit holds — an untracked file, or one staged as an addition — is untracked and deleted, because there is no earlier version to restore. Unmerged paths are skipped: Git refuses to restore one side of a conflict the user never chose. Untracked removal runs `git clean` without `-x`, so an ignored file is never deleted even if Git reports it among the changes. A repository with no commit has nothing to restore to, so additions there are removed outright.

The plugin does not offer a per-hunk revert, a `git revert` of a past commit, or a stash.

Git writes time out after 120 seconds by default (`commitTimeoutMs`, `pushTimeoutMs` in `pi-lazygit.json`); change these settings in that file to configure the limits. Git will not prompt for credentials in the panel. HTTPS disables terminal prompts and relies on noninteractive Git credential helpers. Default SSH uses OpenSSH batch mode and an existing key/agent; configured custom SSH commands are preserved but must explicitly enable OpenSSH `BatchMode=yes` or plink `-batch`, otherwise push fails closed. On Windows, killing Git's direct child on timeout may not terminate hook-spawned grandchildren.

Session baselines can be persisted in `pi-lazygit-cache/v1` under the OMP agent directory returned by OMP (`getAgentDir()`). Cache identity includes canonical repository root, HEAD identity/OID, and index fingerprint; invalid/mismatched data is ignored, and worktree contents are still hashed against the session baseline on every refresh. Worktree edits do not invalidate that baseline; a changed HEAD captures a new session origin, while an index-only change clears its disk checkpoint but preserves the in-memory baseline so staging does not hide prior edits. Caching defaults on (`cacheEnabled` in `pi-lazygit.json`); use `/files-cache on|off` to toggle it and `/clear-cache` to remove this project's cache entry.

## Keys

`?` opens a full list of every shortcut, grouped by navigation, review, layout, and mouse. It leaves selection and preview state untouched; `?` or `Esc` closes it, and `Esc` closes the help before anything else.

### Write-action keys

| Key | Action |
| --- | --- |
| `space` | Toggle the current file selection |
| `x` | Invert the current file selection |
| `A` | Toggle all selection |
| `R` | Offer to revert the ticked files (workspace change list only) |
| `Enter` | Start commit in workspace change list |
| `Ctrl+N` | Toggle `--no-verify` for commit/amend |
| `u` | Amend `HEAD` subject in commit history |
| `P` | Review the checked-out branch's push plan (files, history, or branches view) |
| `y` then `w` | Advance through separate push confirmations |
| Branch name + `Enter` | Confirm a protected-branch push |

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
| `t` | Cycle Pi, Catppuccin, Nord, and Tokyo Night syntax themes |
| `d` | Switch the diff preview between unified and split columns |
| `-` / `=` | Lower/raise diff mask opacity by 10% |
| `i` | Open native `/btw` history above review |
| `m` | Toggle Git review / ordinary directory browsing (also from file preview); preserve Git layout and scope |
| `v` | Toggle the flat change list / modified directory tree in Git mode |
| `s` | Toggle workspace/session scope in Git mode |
| `g` | Switch the left pane between the project tree and the commit history |
| `b` | Switch the left pane to the local branch list |
| `?` | Show every shortcut |
| `F5` / `r` | Refresh Git status, change list, summary, and selected diff or code |
| Left click | Focus the tree and select the clicked row |
| `Esc` | Close the panel from the tree |
| `q` / `Ctrl+C` | Quit the panel from anywhere, including an open commit, amend, or push dialog |

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
| `t` | Cycle Pi, Catppuccin, Nord, and Tokyo Night syntax themes |
| `-` / `=` | Lower/raise diff mask opacity by 10% |
| `i` | Open native `/btw` history above review |
| `g` | Switch the left pane between the project tree and the commit history |
| `b` | Switch the left pane to the local branch list |
| `?` | Show every shortcut |
| `F5` / `r` | Refresh Git status, change list, summary, and selected diff or code |
| `Left` or `h` | Return focus to the project tree |
| Left-button drag | Select preview text; release copies it |
| `Esc` | Return focus to the project tree |
| `q` / `Ctrl+C` | Quit the panel immediately |

Selecting a file begins loading its preview immediately. `Enter` transfers focus to the preview.

Press `F5` from either pane to reload repository status and the selected file together. The refreshed list/tree preserves the selected path when it still exists; otherwise it moves to the nearest surviving row.

### Native `/btw` history

| Key | Action |
| --- | --- |
| `Up` / `Down` | Select a side conversation |
| `Tab` or `Left` / `Right` | Switch between conversation list and details |
| `f` / `Enter` | Open OMP's native follow-up input for the selected topic |
| `Esc` | Close `/btw` history and return to review |

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
| `P` | Review the checked-out branch's push plan |
| `F5` / `r` | Reload the commit history |
| Left click | Select the clicked commit |
| `Esc` | Close the panel |
| `q` / `Ctrl+C` | Quit the panel from anywhere |

### Branches

Replaces the project tree keys while the branch list is shown (`b`).

| Key | Action |
| --- | --- |
| `n` / `p` | Move the branch selection to the next/previous row |
| `Up` / `Down` | Move the branch selection |
| `Enter` | Switch to the selected branch; a no-op on the current branch |
| `b` / `Esc` | Return to the project tree without switching |
| `P` | Review the checked-out branch's push plan, regardless of the selected row |
| `?` | Show every shortcut |
| Left click | Select the clicked branch; it never switches |

## Review modes and scopes

The Git panel opens in **Git mode**, showing the change list. Press `m` to switch between Git review and ordinary directory browsing, including while the file preview has focus. Returning restores the previous Git list/tree layout and review scope. `v` only changes the layout within Git mode; there are no separate enter-directory or enter-Git shortcuts.

- **Git mode** shows only changes in the active scope. `v` switches between the flat change list and the directory tree of changed paths.
- **Change list** (default) shows full project paths under two dividers: `Modified files` for tracked changes, then `No version files` for untracked files. Each file is listed once, most recently modified file first. A path with no file in the worktree — a deletion, a submodule, an untracked nested repository — has no modification time and sorts after every dated path; the two groups are ordered by path. Empty groups are omitted. The dividers are display-only: keyboard navigation skips them, and clicking them does not change the selected file.
- **Directory mode** shows the complete Git-visible file tree, including unchanged code. Deleted paths are excluded. Preview reads current file contents rather than a Git diff; there are no commit checkboxes or diff totals. `Enter` opens the file, never commits it. `v` and `s` are inactive here. Repository-level history, branches, and confirmed push remain available.
- **Workspace scope** shows current working-tree changes relative to `HEAD`, including staged and unstaged changes.
- **Session scope** (`s`, Git mode only) shows changes since the repository snapshot captured for the current OMP session.

The active repository baseline is captured at `session_start`, before the panel opens. A repository first visited later in the same OMP session receives a baseline on first access. When caching is enabled, a validated persistent copy may preload this baseline; cache identity mismatches are treated as misses. Baseline data survives in memory until `session_shutdown`; if caching is enabled it is also persisted for a later session.

Session scope is temporal attribution, not Agent attribution. Any edit made after the baseline counts, including edits made by external programs, other terminals, or people. A file restored to its baseline state disappears from session scope.

Tracked files display a fresh `HEAD`-to-working-tree diff that combines staged and unstaged changes, even when they changed since the last file-list refresh. Deleted files display their deletion diff. Untracked and unchanged text files display read-only, line-numbered content. Binary files display metadata instead of raw bytes.

## Non-Git directories

Outside a Git repository, the panel opens directly in the same read-only directory browser rooted at OMP's current working directory. It includes ordinary entries except `.git`; files preview their current contents. Git mode, workspace/session scope, history, branches, and Git writes are unavailable. Git ignore rules do not apply outside Git repositories.

## Limits

To keep the OMP session responsive:

- Preview source or diff input is limited to 1 MiB per file.
- A preview renders at most 5,000 logical lines.
- Non-Git filesystem traversal stops after 20,000 entries.
- The commit history lists at most the 200 most recent commits.
- Commit, amend, and push time out after 120 seconds by default; configure `commitTimeoutMs` and `pushTimeoutMs` in `pi-lazygit.json`.
- Git add stages selected paths in batches of 200; the final commit command still includes the complete selected path list and can exceed the platform command-line limit for exceptionally large selections.
- Amend can update only `HEAD`'s subject; older commits are not amendable.
- Force push is never available.

The panel displays a truncation state when a limit is reached. Directory browsing in a Git project includes tracked and untracked/non-ignored paths, excludes ignored and deleted paths, and never traverses `.git` internals.

## Scope and safety

Reviewing files, diffs, and history does not write to the repository. Explicit writes are limited to switching to a local branch, committing selected workspace paths, discarding the confirmed revert selection, amending the current `HEAD` subject, and pushing the reviewed upstream plan. These ordinary Git operations update branch refs as needed; there are no separate branch/tag/ref management controls. The panel does not fetch, stash, or apply/revert individual hunks; force push is never available. No write is implicit in selecting or previewing a row. Session scope describes changes since the baseline, not which Agent produced them.

## Development checks

All automated test files live under `test/`, mirroring the `src/` subdirectories. Production source stays under `src/`.

```powershell
bun run check
bun test ./test/ui/files-panel.test.ts ./test/review-source.test.ts
```

## License / 许可证

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- Personal noncommercial use, including study, experimentation, entertainment, and hobby projects, is permitted.
- Commercial use is not licensed. Obtain a separate license from the copyright holder before commercial use.
- Noncommercial use by the organizations listed in the license, including educational and charitable institutions, is also permitted.
- Copies and modified versions must retain the license terms or their URL and the required copyright notice.

This is a source-available license, not MIT or an OSI-approved open-source license. Third-party dependencies retain their own licenses. The full license text controls.

本项目允许个人非商业用途，包括学习、实验、娱乐和业余项目；不授予商业使用权，商业使用前须另行取得著作权人的许可。也允许许可证列明的教育、慈善等机构用于条款允许的用途。分发原版或修改版时，须保留许可证全文或其链接，以及必需的版权声明。

这是源码可见的非商业许可证，不是 MIT，也不是 OSI 认可的开源许可证。第三方依赖仍遵循各自的许可证。具体权利和义务以许可证全文为准。
