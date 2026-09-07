# Pi Files Review Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable OMP extension that opens a keyboard-driven project tree and selected-file diff/content preview inside the current interactive OMP session.

**Architecture:** A small extension entry mounts one `FilesPanel` through `ctx.ui.custom`. Git/process access, temporal session baselines, tree construction, preview loading, and TUI rendering remain separate modules connected through immutable contracts in `src/contracts.ts`. The implementation uses the installed Git executable and OMP's public extension/TUI APIs; no embedded Git implementation or external TUI is introduced.

**Tech Stack:** Bun 1.3.14+, TypeScript ESM, `@oh-my-pi/pi-coding-agent` 18.0.11+, `@oh-my-pi/pi-tui` 18.0.11+, Bun test, system Git.

## Global Constraints

- Validate interactive behavior against the installed `omp/18.0.11` executable in Windows PowerShell/Windows Terminal.
- Register `/files` and `Ctrl+Shift+G`; both call the same guarded `openFileReview` flow.
- Git all-files mode contains tracked plus untracked/non-ignored paths and never `.git` internals.
- Tracked changes preview the combined `HEAD`-to-working-tree diff; untracked and unchanged files preview line-numbered content.
- Session scope is a temporal comparison against the session/repository baseline, not exact Agent attribution.
- Preview input is capped at 1 MiB and rendered output at 5,000 logical lines.
- Non-Git traversal excludes `.git` and stops after 20,000 entries.
- Git commands use executable-plus-argument arrays; never interpolate repository paths into shell commands.
- Every external path/output is sanitized and every rendered row stays within visual terminal width.
- No staging, editing, reverting, committing, syntax highlighting, or persisted baselines.
- Workers implementing parallel tasks MUST skip formatters, project-wide tests, and full builds; the integration owner runs them once.

## File Map and Ownership

| File | Responsibility | Owner |
|---|---|---|
| `package.json`, `tsconfig.json`, `.gitignore` | Package/toolchain scaffold | Foundation |
| `src/contracts.ts` | Cross-module immutable data and service interfaces | Foundation |
| `src/contracts.test.ts` | Contract helper invariants | Foundation |
| `src/git/process.ts`, `src/git/process.test.ts` | Bounded direct process execution | Git data |
| `src/git/status.ts`, `src/git/status.test.ts` | Porcelain `-z` parsing and status normalization | Git data |
| `src/git/repository.ts`, `src/git/repository.integration.test.ts` | Git inspection, visible paths, diff/content preview, summary | Git data |
| `src/filesystem.ts`, `src/filesystem.test.ts` | Non-Git bounded traversal and content preview | Git data |
| `src/model/tree.ts`, `src/model/tree.test.ts` | Hierarchy, filtering, expansion, flattening, selection recovery | Model |
| `src/model/baseline.ts`, `src/model/baseline.test.ts` | Per-session/repository temporal baseline comparison | Model |
| `src/ui/files-panel.ts`, `src/ui/files-panel.test.ts` | TUI state machine, async refresh, rendering, input, disposal | TUI |
| `src/ui/render.ts`, `src/ui/render.test.ts` | Width-safe boxes, colors, clipping, line-number/diff rendering | TUI |
| `src/index.ts`, `src/index.test.ts` | Extension registration and one-panel guard | Entry |
| `README.md` | Install and usage instructions | Entry |
| `src/review-source.ts`, `src/review-source.test.ts` | Integration adapter joining Git/filesystem, baseline, and panel contracts | Integration |
| `test/smoke-fixture.ts` | Deterministic temporary Git workspace helper | Integration |

## Locked Cross-Module Contracts

`src/contracts.ts` is the only shared mutation boundary before the parallel wave. It exports these exact public shapes:

```ts
export const MAX_PREVIEW_BYTES = 1_048_576;
export const MAX_PREVIEW_LINES = 5_000;
export const MAX_FILESYSTEM_ENTRIES = 20_000;

export type ViewMode = "modified" | "all";
export type ChangeScope = "workspace" | "session";
export type StatusCode = "M" | "A" | "D" | "R" | "?" | "U";

export interface ChangeRecord {
  readonly path: string;
  readonly oldPath?: string;
  readonly index: string;
  readonly worktree: string;
  readonly status: StatusCode;
}

export interface ChangeSummary {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface ProjectSnapshot {
  readonly kind: "git" | "filesystem";
  readonly root: string;
  readonly hasHead: boolean;
  readonly allFiles: readonly string[];
  readonly workspaceChanges: ReadonlyMap<string, ChangeRecord>;
  readonly sessionChanges: ReadonlyMap<string, ChangeRecord>;
  readonly workspaceSummary: ChangeSummary;
  readonly sessionSummary: ChangeSummary;
  readonly baselineEstablishedAt?: number;
  readonly truncated: boolean;
}

export interface FilePreview {
  readonly path: string;
  readonly kind: "diff" | "text" | "binary" | "error";
  readonly lines: readonly string[];
  readonly byteSize?: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface RefreshOptions {
  readonly signal: AbortSignal;
}

export interface PreviewOptions {
  readonly signal: AbortSignal;
}

export interface ReviewSource {
  refresh(options: RefreshOptions): Promise<ProjectSnapshot>;
  preview(path: string, options: PreviewOptions): Promise<FilePreview>;
}

export interface BaselineEntry {
  readonly status: StatusCode;
  readonly hash: string | null;
}

export interface RepositoryBaseline {
  readonly root: string;
  readonly establishedAt: number;
  readonly entries: ReadonlyMap<string, BaselineEntry>;
}
```

The foundation commit lands first. Git data, model, TUI, and entry tasks then run concurrently and may import these contracts but MUST NOT modify `src/contracts.ts`, `package.json`, or `tsconfig.json`. The integration owner is the only worker allowed to revise a locked contract after the parallel wave.

---

### Task 1: Package Foundation and Locked Contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/contracts.ts`
- Create: `src/contracts.test.ts`

**Interfaces:**
- Consumes: approved design at `docs/superpowers/specs/2026-09-08-pi-files-review-design.md`.
- Produces: every exact type and constant in “Locked Cross-Module Contracts”.

- [ ] **Step 1: Add the package manifest and compiler configuration**

```json
{
  "name": "pi-lazygit",
  "version": "0.1.0",
  "description": "Review project files and Git diffs inside Oh My Pi",
  "type": "module",
  "private": true,
  "engines": { "bun": ">=1.3.14" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun test"
  },
  "omp": { "extensions": ["./src/index.ts"] },
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": ">=18.0.11 <19",
    "@oh-my-pi/pi-tui": ">=18.0.11 <19"
  },
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "18.0.11",
    "@oh-my-pi/pi-tui": "18.0.11",
    "@types/bun": "latest",
    "typescript": "^5.9.2"
  }
}
```

Use `module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and Bun types. Ignore `node_modules/`, coverage, build output, and temporary smoke repositories.

- [ ] **Step 2: Write a failing contract-helper test**

Add and test two helpers in the contract module: `emptySummary()` returns a fresh zeroed summary and `changeMap(records)` returns a map keyed by normalized `/` paths.

```ts
import { expect, test } from "bun:test";
import { changeMap, emptySummary } from "./contracts";

test("changeMap normalizes separators and keys by current path", () => {
  const map = changeMap([{ path: "src\\a.ts", index: " ", worktree: "M", status: "M" }]);
  expect([...map.keys()]).toEqual(["src/a.ts"]);
  expect(map.get("src/a.ts")?.path).toBe("src/a.ts");
});

test("emptySummary returns independent immutable-shaped values", () => {
  expect(emptySummary()).toEqual({ files: 0, insertions: 0, deletions: 0 });
  expect(emptySummary()).not.toBe(emptySummary());
});
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `bun test src/contracts.test.ts`

Expected: failure because `./contracts` or the helper exports do not exist.

- [ ] **Step 4: Implement the locked contracts and helpers**

Create the constants/types exactly as shown above. Normalize `\\` to `/` in `changeMap`, clone records whose path changes, and return a new `Map` without mutating the caller's array.

- [ ] **Step 5: Install dependencies and run the focused checks**

Run: `bun install`

Run: `bun test src/contracts.test.ts && bun run typecheck`

Expected: both commands exit 0.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json bun.lock tsconfig.json .gitignore src/contracts.ts src/contracts.test.ts
git commit -m "build: scaffold pi files extension"
```

---

### Task 2: Git and Filesystem Data Sources

**Files:**
- Create: `src/git/process.ts`
- Create: `src/git/process.test.ts`
- Create: `src/git/status.ts`
- Create: `src/git/status.test.ts`
- Create: `src/git/repository.ts`
- Create: `src/git/repository.integration.test.ts`
- Create: `src/filesystem.ts`
- Create: `src/filesystem.test.ts`

**Interfaces:**
- Consumes: constants and data types from `src/contracts.ts`.
- Produces:

```ts
export interface CommandOutput {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

export interface ProcessRunner {
  run(cwd: string, executable: string, args: readonly string[], signal: AbortSignal, maxBytes?: number): Promise<CommandOutput>;
}

export class BunProcessRunner implements ProcessRunner { /* public run signature above */ }
export function parsePorcelainV1Z(bytes: Uint8Array): Map<string, ChangeRecord>;

export interface RepositoryInspection {
  readonly root: string;
  readonly hasHead: boolean;
  readonly allFiles: readonly string[];
  readonly changes: ReadonlyMap<string, ChangeRecord>;
  readonly summary: ChangeSummary;
}

export class GitRepository {
  constructor(runner?: ProcessRunner);
  static open(cwd: string, runner?: ProcessRunner, signal?: AbortSignal): Promise<GitRepository | undefined>;
  inspect(signal: AbortSignal): Promise<RepositoryInspection>;
  contentHash(path: string, signal: AbortSignal): Promise<string | null>;
  preview(path: string, signal: AbortSignal): Promise<FilePreview>;
}

export class FilesystemProject {
  constructor(readonly root: string);
  inspect(signal: AbortSignal): Promise<{ allFiles: readonly string[]; truncated: boolean }>;
  preview(path: string, signal: AbortSignal): Promise<FilePreview>;
}
```

- [ ] **Step 1: Write failing parser tests for NUL-delimited Git status**

Cover ordinary changes, untracked paths, conflict pairs, rename records, Unicode, spaces, and backslash normalization. A rename test must use the actual v1 `-z` order (`R  new\0old\0`) and expect the current path as the map key.

```ts
const bytes = new TextEncoder().encode(" M src/a.ts\0R  新 name.ts\0old name.ts\0?? untracked file.ts\0");
const records = parsePorcelainV1Z(bytes);
expect(records.get("新 name.ts")).toMatchObject({ oldPath: "old name.ts", status: "R" });
expect(records.get("untracked file.ts")?.status).toBe("?");
```

- [ ] **Step 2: Run the parser test and confirm failure**

Run: `bun test src/git/status.test.ts`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement strict porcelain parsing**

Parse bytes by NUL boundaries, consume the second path for rename/copy status, map conflict combinations (`DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`) to `U`, and apply display precedence `U > R > D > A/? > M`. Reject malformed records with a descriptive `GitOutputError` rather than silently shifting subsequent paths.

- [ ] **Step 4: Write failing bounded-runner tests**

Use `process.execPath` with a tiny fixture script that emits stdout/stderr, exceeds a byte cap, and waits for cancellation. Assert argument boundaries preserve a value containing spaces and `&`, stdout is capped, `truncated` is true, and abort terminates the child.

- [ ] **Step 5: Implement direct bounded process execution**

Use `Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" })`. Read stdout incrementally, retain at most `maxBytes` (default 8 MiB), drain stderr with a 64 KiB cap, register one abort listener, kill on abort, remove the listener in `finally`, and throw an `AbortError` for cancellation. Never call `Bun.$`, `sh`, `cmd.exe`, or PowerShell.

- [ ] **Step 6: Write failing temporary-repository integration tests**

Create isolated repositories under `fs.mkdtemp`, set local user identity, and cover:

```ts
expect((await repo.inspect(signal)).allFiles).toContain("src/space name.ts");
expect((await repo.preview("tracked.ts", signal)).kind).toBe("diff");
expect((await repo.preview("new.ts", signal))).toMatchObject({ kind: "text", truncated: false });
```

Also assert staged plus unstaged edits both appear against `HEAD`, deletion previews work, ignored files are excluded, no-HEAD repositories return content previews, binary files return metadata, input over 1 MiB truncates, and Unicode paths round-trip.

- [ ] **Step 7: Implement `GitRepository`**

Use these commands with argument arrays:

```text
git rev-parse --show-toplevel
git rev-parse --verify HEAD
git status --porcelain=v1 -z --untracked-files=all
git ls-files -z --cached --others --exclude-standard
git diff --no-ext-diff --no-color --unified=3 HEAD -- <path>
git diff --no-ext-diff --no-color --numstat HEAD -- .
```

When `HEAD` is absent, preview every existing changed file as content and count each text file's available lines as insertions; deleted paths contribute a changed file and zero lines. Treat `?` files as content in repositories with `HEAD`. Detect binary input from a NUL byte in the bounded prefix. Prefix text content lines with right-aligned line numbers. Count untracked text lines as insertions in the summary without reading beyond the preview cap; binary files contribute one changed file and zero line totals. Return user-facing errors in `FilePreview` but throw repository-level inspection errors.

- [ ] **Step 8: Write failing filesystem-fallback tests**

Assert deterministic relative `/` paths, `.git` exclusion, binary/text preview behavior, abort handling, symlink non-recursion, and a fixture seam that lowers the entry limit to verify truncation without creating 20,001 files.

- [ ] **Step 9: Implement `FilesystemProject`**

Use iterative directory traversal, never follow directory symlinks, sort directory entries case-insensitively before enqueueing, stop at `MAX_FILESYSTEM_ENTRIES`, and reject preview paths that resolve outside `root`.

- [ ] **Step 10: Run only owned tests and commit**

Run: `bun test src/git/process.test.ts src/git/status.test.ts src/git/repository.integration.test.ts src/filesystem.test.ts`

Expected: all owned tests pass.

```bash
git add src/git src/filesystem.ts src/filesystem.test.ts
git commit -m "feat: add git and filesystem data sources"
```

---

### Task 3: Project Tree and Session Baselines

**Files:**
- Create: `src/model/tree.ts`
- Create: `src/model/tree.test.ts`
- Create: `src/model/baseline.ts`
- Create: `src/model/baseline.test.ts`

**Interfaces:**
- Consumes: `ChangeRecord`, `StatusCode`, `BaselineEntry`, and `RepositoryBaseline` from `src/contracts.ts`.
- Produces:

```ts
export interface TreeNode {
  readonly kind: "directory" | "file";
  readonly name: string;
  readonly path: string;
  readonly status?: StatusCode;
  readonly children: readonly TreeNode[];
}

export interface TreeRow {
  readonly node: TreeNode;
  readonly depth: number;
  readonly expanded: boolean;
}

export function buildTree(paths: readonly string[], changes: ReadonlyMap<string, ChangeRecord>): TreeNode;
export function flattenTree(root: TreeNode, expanded: ReadonlySet<string>): readonly TreeRow[];
export function visiblePaths(allFiles: readonly string[], changes: ReadonlyMap<string, ChangeRecord>, mode: ViewMode): readonly string[];
export function recoverSelection(rows: readonly TreeRow[], previousPath: string | undefined, previousIndex: number): number;

export type HashFile = (absolutePath: string, signal: AbortSignal) => Promise<string | null>;

export class BaselineStore {
  capture(root: string, changes: ReadonlyMap<string, ChangeRecord>, hashFile: HashFile, signal: AbortSignal, now?: number): Promise<RepositoryBaseline>;
  get(root: string): RepositoryBaseline | undefined;
  compare(root: string, current: ReadonlyMap<string, ChangeRecord>, hashFile: HashFile, signal: AbortSignal): Promise<Map<string, ChangeRecord>>;
  clear(): void;
}
```

- [ ] **Step 1: Write failing tree behavior tests**

Test directory-first case-insensitive ordering, original spelling, ancestor status propagation, modified-only filtering, all-mode completeness, expansion flattening, empty trees, and selection recovery. Include `src/a.ts`, `src/Auth/z.ts`, `README.md`, and a renamed path.

- [ ] **Step 2: Run the tree test and confirm failure**

Run: `bun test src/model/tree.test.ts`

Expected: missing-module or missing-export failure.

- [ ] **Step 3: Implement immutable tree operations**

Normalize paths once, reject empty/absolute/parent-traversal paths, build through mutable local assembly nodes, then freeze the returned read model. Directory status is the highest-precedence descendant status using `U > R > D > A/? > M`. `recoverSelection` first matches the previous path, then clamps the previous index.

- [ ] **Step 4: Write failing baseline tests**

Use a fake `HashFile` map and verify:

```ts
await store.capture(root, initialChanges, hashFile, signal, 1234);
expect(store.get(root)?.establishedAt).toBe(1234);
expect(await store.compare(root, initialChanges, hashFile, signal)).toHaveSize(0);
```

Then cover a clean-at-baseline file becoming modified, a pre-existing dirty file changing hash, a pre-existing dirty file retaining its hash, deletion status changes, restored-to-baseline content disappearing, root path case normalization on Windows, abort, and `clear()`.

- [ ] **Step 5: Implement baseline capture and comparison**

Hash only changed/untracked existing files during capture. Store `null` for deleted/missing content. During compare, include a current record when no baseline entry exists, its status differs, or its current hash differs. Compare canonical repository-root keys case-insensitively on Windows without lowercasing display paths.

- [ ] **Step 6: Run only owned tests and commit**

Run: `bun test src/model/tree.test.ts src/model/baseline.test.ts`

Expected: all owned tests pass.

```bash
git add src/model
git commit -m "feat: add review tree and session baselines"
```

---

### Task 4: Width-Safe TUI Panel

**Files:**
- Create: `src/ui/render.ts`
- Create: `src/ui/render.test.ts`
- Create: `src/ui/files-panel.ts`
- Create: `src/ui/files-panel.test.ts`

**Interfaces:**
- Consumes: `ReviewSource`, `ProjectSnapshot`, `FilePreview`, `ViewMode`, and `ChangeScope` from `src/contracts.ts`; tree exports from `src/model/tree.ts`; OMP `Component`, `TUI`, `Theme`, `KeybindingsManager` public types.
- Produces:

```ts
export interface FilesPanelOptions {
  readonly cwd: string;
  readonly source: ReviewSource;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly sessionName?: string;
  readonly done: (result: undefined) => void;
}

export class FilesPanel implements Component {
  constructor(options: FilesPanelOptions);
  start(): void;
  handleInput(data: string): void;
  render(width: number): readonly string[];
  invalidate(): void;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing render-primitive tests**

Test `fitCell`, `sanitizeTerminalText`, `renderDiffLine`, `renderNumberedLine`, and border composition with ASCII, CJK, combining characters, tabs, embedded control/ANSI sequences, and widths 1–120. Every assertion must verify `visibleWidth(line) <= width`.

- [ ] **Step 2: Implement width-safe rendering helpers**

Use OMP `visibleWidth`, `truncateToWidth`, and `replaceTabs`; strip C0 controls except normalized line boundaries and neutralize escape sequences before theme styling. Diff precedence is file headers (`diff --git`, `---`, `+++`), hunk headers (`@@`), additions, deletions, then ordinary context.

- [ ] **Step 3: Write failing panel state-machine tests**

Provide a fake `ReviewSource`, fake `TUI` exposing `terminal.columns`, `terminal.rows`, and `requestRender`, and deterministic theme/key matcher. Assert:

- initial state is `modified + workspace + tree focus`;
- `a`, `m`, and `s` rebuild visible rows correctly;
- arrows and `j/k/h/l` navigate and expand;
- `Enter` on a file focuses preview;
- preview scrolling clamps at both ends;
- `Esc` returns to tree then calls `done(undefined)` exactly once;
- `r` retains selection when the path survives;
- late preview result A cannot replace newer result B;
- `dispose()` aborts refresh and preview work and is idempotent.

- [ ] **Step 4: Run the panel test and confirm failure**

Run: `bun test src/ui/files-panel.test.ts`

Expected: missing-module or missing-export failure.

- [ ] **Step 5: Implement asynchronous panel state**

Use separate `AbortController`s and monotonically increasing request generations for refresh and preview. `start()` schedules the first refresh without blocking component construction. Every resolved current-generation operation calls `tui.requestRender()` once; aborted/stale operations do not mutate state.

Use `keybindings.matches(data, "app.interrupt")` in addition to raw `Esc`; use OMP `matchesKey` for named keys. `done` is guarded by a boolean.

- [ ] **Step 6: Implement responsive rendering**

Use `tui.terminal.rows` to cap panel height. Reserve top border and footer; derive content height with a minimum of one row. At width >= 80 render a 42%/58% split with one shared divider. Below 80 render the focused pane full width. Keep the selected tree row visible by adjusting its viewport offset. Cache and reuse the exact rendered array reference until state, theme, width, or terminal row count changes.

All-files mode always passes all paths to `buildTree`; active-scope changes determine markers and summary. Modified mode passes only active-scope changed paths. In filesystem snapshots, ignore `m` and `s` and show all paths.

- [ ] **Step 7: Add deterministic rendering snapshots as explicit arrays**

Do not use opaque snapshot files. Assert exact arrays for one 100-column wide layout, one 60-column tree layout, one 60-column preview layout, loading, empty, binary, truncated, and error states. Also loop over every rendered line and assert its visible width does not exceed the requested width.

- [ ] **Step 8: Run only owned tests and commit**

Run: `bun test src/ui/render.test.ts src/ui/files-panel.test.ts`

Expected: all owned tests pass.

```bash
git add src/ui
git commit -m "feat: add files review TUI panel"
```

---

### Task 5: Extension Entry and User Installation Surface

**Files:**
- Create: `src/index.ts`
- Create: `src/index.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `ReviewSource` from `src/contracts.ts` and `FilesPanel`/`FilesPanelOptions` from `src/ui/files-panel.ts`. During this parallel task, use injected factories in tests rather than constructing not-yet-integrated Git services.
- Produces:

```ts
export interface ExtensionDependencies {
  readonly createReviewSource: (cwd: string) => ReviewSource;
  readonly prepareSession: (cwd: string) => Promise<void>;
  readonly clearSession: () => void;
  readonly createPanel: (options: FilesPanelOptions) => FilesPanel;
}

export const FILES_SHORTCUT = "ctrl+shift+g";
export function createExtension(dependencies?: ExtensionDependencies): (pi: ExtensionAPI) => void;
export default function extension(pi: ExtensionAPI): void;
```

Production defaults are imported from `src/review-source.ts`; injected dependencies keep registration tests independent from Git and the not-yet-integrated modules.

- [ ] **Step 1: Write failing registration tests**

Use a fake `ExtensionAPI` recording `registerCommand`, `registerShortcut`, and lifecycle handlers. Assert exact registrations:

```ts
expect(commands.get("files")?.description).toContain("files");
expect(shortcuts.get("ctrl+shift+g")).toBeDefined();
```

Invoke both open handlers with the same fake context and assert they call one injected opener. Invoke twice before the first custom UI promise resolves and assert only one panel is created. Verify `ctx.hasUI === false` sends one warning notification and mounts nothing. Emit `session_start` and assert `prepareSession(ctx.cwd)` captures the baseline before `/files` opens; emit `session_shutdown` and assert `clearSession()` runs.

- [ ] **Step 2: Run the entry test and confirm failure**

Run: `bun test src/index.test.ts`

Expected: missing-module or missing-export failure.

- [ ] **Step 3: Implement extension registration and panel guard**

Register at factory load time only. The opener calls:

```ts
await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
  const panel = createPanel({ cwd: ctx.cwd, source, tui, theme, keybindings, sessionName: pi.getSessionName(), done });
  panel.start();
  return panel;
});
```

Use `try/finally` to clear the one-panel guard. Report constructor/runtime errors through `ctx.ui.notify(message, "error")`. Register `session_start` to await `prepareSession(ctx.cwd)` and report a baseline failure as a warning without breaking OMP startup. Register `session_shutdown` to call `clearSession()`. These handlers are registered during module load, but runtime work occurs only when the lifecycle events fire.

- [ ] **Step 4: Write installation and usage instructions**

`README.md` must contain:

- prerequisites: OMP >=18.0.11, Bun >=1.3.14, Git for Git mode;
- `bun install`;
- `omp plugin link .` as the primary local install;
- `omp --extension ./src/index.ts` as a one-run development path;
- `/files`, `Ctrl+Shift+G`, and every panel key;
- workspace/session snapshot semantics and the fact that external edits after baseline count;
- preview and filesystem traversal limits;
- non-goals: read-only, no stage/revert/edit.

- [ ] **Step 5: Run only owned tests and commit**

Run: `bun test src/index.test.ts`

Expected: registration and guard tests pass with injected fakes.

```bash
git add src/index.ts src/index.test.ts README.md
git commit -m "feat: register files review extension"
```

---

### Task 6: Integration Adapter, Full Verification, and Cleanup

**Files:**
- Create: `src/review-source.ts`
- Create: `src/review-source.test.ts`
- Create: `test/smoke-fixture.ts`
- Modify only when integration proves necessary: `src/index.ts`, `src/ui/files-panel.ts`, `src/contracts.ts`, `package.json`, `README.md`

**Interfaces:**
- Consumes: all prior task exports.
- Produces: production `ReviewSource`, final package, and verified interactive extension.

```ts
export class ProjectReviewSource implements ReviewSource {
  constructor(cwd: string, baselines: BaselineStore, runner?: ProcessRunner);
  establishBaseline(signal: AbortSignal): Promise<void>;
  refresh(options: RefreshOptions): Promise<ProjectSnapshot>;
  preview(path: string, options: PreviewOptions): Promise<FilePreview>;
}

export function prepareSessionBaseline(cwd: string): Promise<void>;
export function clearSessionBaselines(): void;
```

- [ ] **Step 1: Write failing adapter tests**

Inject fake Git/filesystem factories. Assert Git refresh joins `inspect()` with `BaselineStore.compare()`, chooses correct workspace/session summaries, uses a baseline previously created by `prepareSessionBaseline`, and delegates preview to the active backend. Assert a repository first visited after session start establishes its baseline once on first refresh. Assert non-Git refresh returns `kind: "filesystem"`, empty change maps/summaries, and no baseline timestamp.

- [ ] **Step 2: Implement the adapter**

`prepareSessionBaseline(cwd)` attempts `GitRepository.open`, inspects the active repository, and captures its baseline before the user can open the panel. `refresh()` reuses that baseline. If a Git repository has no baseline because the session moved to it later, refresh captures one before returning the first snapshot, so its initial session change map is empty and `baselineEstablishedAt` exposes when this happened. Filesystem mode uses `FilesystemProject`. Cache sources by canonical root, always re-inspect on `r`, and make `clearSessionBaselines()` clear both baseline and backend registries on `session_shutdown`.

- [ ] **Step 3: Run adapter and changed-contract tests**

Run: `bun test src/review-source.test.ts src/index.test.ts src/ui/files-panel.test.ts`

Expected: all pass. Fix only real interface integration issues; do not weaken assertions or add compatibility aliases.

- [ ] **Step 4: Run complete automated verification through context-mode**

Run: `bun run typecheck`

Run: `bun test`

Expected: both exit 0. Review all output for leaked child processes, unhandled rejections, skipped tests, and terminal-width assertion failures.

- [ ] **Step 5: Build the real PowerShell smoke fixture**

`test/smoke-fixture.ts` creates a temporary repository with:

- committed `src/auth/login.ts` and `tests/auth.test.ts`;
- staged `src/auth/token.ts`;
- unstaged edit in `src/auth/login.ts`;
- untracked Unicode file `src/说明.txt`;
- ignored `node_modules/ignored.js`;
- one binary file.

It prints only the fixture path and cleanup command. It does not mock Git or OMP.

- [ ] **Step 6: Verify the actual OMP surface**

From PowerShell, run the fixture helper, then launch:

```powershell
omp --extension C:\Users\lhc\Documents\pi-lazygit\src\index.ts
```

In the actual session:

1. type sentinel editor text without submitting it;
2. invoke `/files` and verify the split tree/diff surface;
3. navigate to the Unicode/untracked file and verify numbered content;
4. press `m`, `a`, `s`, `r`, `Enter`, scroll keys, and `Esc`;
5. verify ignored files never appear and binary metadata does;
6. reopen with `Ctrl+Shift+G`;
7. close and verify the sentinel editor text is restored exactly.

Capture terminal evidence through the available browser/terminal surface. If the harness cannot send the shortcut, verify `/hotkeys` lists `Ctrl+Shift+G` and exercise the registered handler in the integration test; report the exact unverified physical chord rather than claiming it was pressed.

- [ ] **Step 7: Perform required cleanup after smoke success**

Remove smoke temporary repositories. Confirm README commands match the tested commands, package manifest points at `src/index.ts`, no scaffold stubs remain, no obsolete exports/aliases exist, and no generated coverage/build artifacts are tracked.

- [ ] **Step 8: Request code review and address only evidenced findings**

Dispatch a reviewer over the complete diff with focus on Windows path safety, Git porcelain correctness, cancellation, terminal width, stale async results, and extension lifecycle. Apply valid findings and rerun only affected checks, then the complete `bun run typecheck` and `bun test` once.

- [ ] **Step 9: Commit the integrated feature**

```bash
git add package.json bun.lock tsconfig.json .gitignore src test README.md
git commit -m "feat: add in-session files review panel"
```

## Parallel Execution Schedule

1. Execute Task 1 alone; it creates the locked contracts and installed dependencies.
2. Dispatch Tasks 2, 3, 4, and 5 in one concurrent agent batch. Each owns disjoint files and skips project-wide validation.
3. After all four complete, dispatch one integration owner for Task 6.
4. Dispatch one read-only reviewer after integration, then apply findings centrally.
5. Run final typecheck, full tests, and actual OMP smoke only once from the main/integration path.
