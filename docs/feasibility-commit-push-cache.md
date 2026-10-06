# 可行性评估：commit / push 与本地缓存

- 调研日期：2026-10-05
- 范围：只做评估，未落实现代码；所有结论均基于已读源码
- 基线：`bun run typecheck` → exit 0（零诊断）；`bun test` → 230 pass / 0 fail（5783 expect()，16 个文件，22.67s）
- 关联文档：`docs/superpowers/specs/2026-09-21-panel-redesign-branch-switching-design.md`（分支切换是仓库里唯一的先例写操作，本文的 commit/push 方案沿用同一套交互契约）

---

## 结论速览

| 能力 | 判定 | 一句话理由 |
| --- | --- | --- |
| commit（含左栏勾选） | **有条件可行** | `GitRepository` 已有 `run()` 私通道与 `switchBranch()` 写操作先例；但 `porcelain=v1` 不给暂存区视图，`ProcessRunner` 无超时/无 stdin，commit message 无输入组件 |
| push | **有条件可行（风险最高）** | 命令层无阻碍，缺的是超时、凭证提示、取消、以及与 watch 刷新的竞态处理 |
| 本地缓存 | **可行** | 现有 `BaselineStore` 是纯内存 `Map` 且每次会话重建，落盘是净增能力；但必须自己解决失效判断与原子写入 |

「有条件可行」的具体条件在每节末尾的**前置条件**里列全。

---

## 0. 决策记录（2026-10-05 已确认）

| # | 决策 | 影响 |
| --- | --- | --- |
| D1 | **push 要做，并且必须有二次确认** | 阶段 3 由「可选项」升为必做项；2.2 的超时、凭证环境、upstream 校验全部变成硬需求；2.3 重写为二级确认设计 |
| D2 | **已跟踪改动默认勾选，未跟踪文件默认不勾选（0.7.1 修订）** | Modified files 默认勾选；No version files 可手动选择；确认框与 dry-run 仍为必须项。 |
| D3 | **amend 只改 HEAD 提交标题**，不改历史任意提交 | 新增 1.6 节。避免了 `rebase`/`filter-repo` 级别的历史重写，风险从「不可逆」降到「重写最后一个 commit」 |
| D4 | **amend 不动勾选框** | 勾选集合只服务 `commit`。amend 走独立的消息输入框，两者互不干扰 |
| D5 | **永不 force**（含 `force-with-lease`） | 由此产生 D1 的直接后果：amend 一个**已推送**的 commit 后无法 push，见 1.6.4 |

待确认的开放问题见第 9 节。

---

## 1. 结论一：commit —— 有条件可行

### 1.1 现状

仓库里已经有一条完整的写操作链路，commit 只需要沿它扩展，不需要引入新机制：

- `src/git/repository.ts:356` `private run(args, signal, maxBytes?)` —— 唯一的 git 调用出口，返回 `CommandOutput`（`src/git/process.ts:4`），已带 `stderr` 与 `exitCode`。
- `src/git/repository.ts:457` `switchBranch(name, options)` —— 现有唯一的写操作。模式是：先校验入参（`branches()` 里确认分支存在）→ 跑命令 → 非 0 退出抛 `commandFailure()`。
- `src/ui/files-panel.ts:1218` `#beginSwitchBranch(name)` —— UI 侧的完整写操作范式：重入守卫（`#branchSwitching !== undefined` 提前返回）→ 自增 generation → `new AbortController()` → 清空所有并行加载态 → `void promise.then(成功/失败)` → 成功后 `#beginRefresh()`，失败写 `#branchError` 并 `#installWatch()` 恢复监听。
- `src/ui/files-panel.ts:463` `dispose()` 会 abort 全部 7 个 controller（refresh / preview / history / commitDiff / watch / branch / switch），新写操作必须登记进去。
- `src/git/watch.ts:108` `isNoisyMetadataPath` 只过滤 `objects/`、`logs/`、`*.lock`；`refs/` 与 `HEAD` 是被监听的，所以 commit 成功后 watcher 会自动触发刷新，这条链路不需要额外接线。

结论：**git 调用、取消、错误回显、刷新联动全部已就位。**

### 1.2 真正缺的东西

| 缺口 | 位置 | 说明 |
| --- | --- | --- |
| 暂存区视图 | `src/git/status.ts:80` `parsePorcelainV1Z` | 当前只解析一个 `Map<path, ChangeRecord>`，`index`/`worktree` 两列被合并成一个 `StatusCode`。要区分「已暂存 / 未暂存」必须新增 `git status --porcelain=v1 -z` 的 XY 解析（或直接上 `--porcelain=v2`） |
| commit message 输入 | 无 | 面板是全屏 overlay（`src/index.ts:131-141`），焦点被面板独占，omp 的 `Editor` 在 overlay 下不可用。需要面板内自绘一行输入，复用 `pi-tui` 的 `components/input.ts`（`Input` 组件）或 `overlays/ask-dialog.ts` 的问答壳 |
| 命令行 stdin | `src/git/process.ts:79` | `BunProcessRunner` 只接 stdout/stderr，没有 stdin。必须改用 `git commit -m <msg> -- <paths>` 而非 `git commit` 走编辑器（顺带这也是正确的：TUI 里不该拉起 `vi`） |
| 无超时 | `src/git/process.ts:68` | 只有 `AbortSignal`，没有时间上限。commit 的 pre-commit hook 可能挂死，必须由调用方自建 timer（见 1.5） |
| `GitBackend` 白名单 | `src/review-source.ts:24-27` | `type GitBackend = Pick<GitRepository, "inspect" \| "contentHash" \| ...>`，加方法必须同步扩这个 Pick，否则 `ProjectReviewSource` 拿不到 |

### 1.3 勾选式提交（用户明确需求）

需求原文：*左侧文件栏，未提交 file 的需要勾选后，才会提交，可以选中/不选中*。

这个需求正好落在 lazygit 的心智模型上（lazygit 左栏文件列表 `space` 切换暂存，commit 面板只提交暂存区）。对本仓库而言是**自洽的**，因为面板已经有一个「左栏扁平 change list + 两个 section」的布局（`src/model/tree.ts:226` `buildChangeList`，section 常量 `MODIFIED_SECTION_PATH` / `UNVERSIONED_SECTION_PATH`），勾选框插在这一层，不需要改树模型结构。

设计：

**数据结构** —— 在 `FilesPanel` 里新增一个纯内存集合，key 用 project path（与 `ChangeRecord.path` 同源，`normalizeProjectPath` 已统一 `/` 与 `\`）：

```ts
// src/ui/files-panel.ts
#commitSelection = new Set<string>();   // 勾选中的 project path
#commitSelectionInitialized = false;    // 首帧是否已按当前改动集初始化
```

生命周期必须明确，否则勾选状态会「粘」在已经提交掉的文件上：

- 初始化：当前活动改动集中的可提交已跟踪文件默认勾选；未跟踪文件默认不勾选，可手动选择。刷新保留已有手动选择，新出现的文件遵循同一默认规则。
- 清理：刷新后交集剪枝，剔除已不在改动集里的 path。切换 scope 和 commit 成功后重置：剩余已跟踪可提交文件勾选，未跟踪文件不勾选。
- 不持久化：勾选态属于「这一次提交」的意图，跨会话保留会造成幽灵勾选。若要持久化，必须连 `headIdentity` 一起存 key（可复用 `src/model/baseline.ts:45` `baselineKey` 的 `root\0headIdentity` 形态），否则 commit 后 key 失配会全量失效。

**渲染插入点** —— `src/ui/files-panel.ts:1759`：

```ts
raw = `${cursor} ${indent}${row.node.status ?? " "}  ${sanitizeTerminalText(row.node.name)...}`;
```

改为在 `status` 之后插一个 1 字符宽的勾选槽：

```ts
const box = this.#commitSelection.has(row.node.path) ? "[x]" : "[ ]";
raw = `${cursor} ${indent}${row.node.status ?? " "} ${box} ${sanitizeTerminalText(row.node.name)...}`;
```

宽度代价：左栏每行固定 +1 列（`[x]` 3 字符占 3 列）。`#renderTreeRow` 末尾已经走 `fitCell(raw, width)`，`src/ui/render.ts` 的 `fitCell` 会截断，窄宽度下不会溢出，但要注意 `TREE_MIN_COLUMNS = 12`（`src/contracts.ts:12`）的左下界——勾选框会让最小可用宽度下的文件名少 1 列。建议勾选框只在 `#usesChangeList()` 为真时渲染，目录树布局（`viewMode: "all"`）不画，保持现有观感。

**按键契约** —— `handleInput`（`src/ui/files-panel.ts:303`）的全局段已占用 `escape / ? / i / f5,r / tab,shift+tab / \,ctrl+b / d / c / -,= / [,] / t / g / b`，左栏段（`#handleTreeInput`，`:500`）已占用 `a / m / v / s / up,p / down,n / left,h / right,l / enter`，预览段还占 `j/k / pgup/dn`。

- `space` —— **完全空闲**，作为「切换当前行勾选」的首选键。它是 lazygit 的肌肉记忆，也符合 checkbox 语义。注意必须放在 `#handleTreeInput` 的 tree 分支里、且在 `#focus === "preview"` 之后才生效（preview 焦点时 space 应无操作或上翻页，需在 `#handlePreviewInput` 里显式吞掉，否则会落到 TUI 默认滚动）。
- `x` —— 备选，空闲键。用于「反选当前行」，让用户不必逐个点。
- `A`（大写 shift+a）—— 全选 / 全不选切换。注意小写 `a` 已被「切到 all/tree 布局」占用（`:534`），必须严格区分大小写。
- `space` 在 section 行（`row.node.kind === "section"`）上应展开为「全选/全不选该 section 下的文件」，这是当前 layout 里 section 行本来就可导航的自然延伸。

冲突检查结论：**无需改动任何现有键**。这是本方案最省事的一点。

**scope 语义边界**（这是最容易被忽略的坑）：

- `#scope === "workspace"` 时改动集是 `workspaceChanges`（HEAD→工作树全量）。
- `#scope === "session"` 时改动集是 `sessionChanges`（`src/review-source.ts:290-298`，由 `BaselineStore.compare()` 对比会话基线哈希得出）。
- **`session` scope 下勾选不能直接喂给 `git commit -- <paths>`**：session 视图是「会话开始后变过的文件」，用 `-- <paths>` 提交会把这些路径上**会话之前就存在的未提交改动**一并带进去。这是 `git commit -- <partial>` 的固有语义，无法绕开。
- 因此规则必须是：**`session` scope 下 commit 按钮禁用**，并在 footer 给出原因（`src/ui/files-panel.ts:1892` `#footer()` 已有 `pieces.push(...)` 的现成位置）。`workspace` scope 才是合法的提交语义。同一原因，`sessionChanges` 里的 `?`（untracked）文件在 workspace scope 下走 `git add -- <path>` 是安全的。

### 1.4 命令序列

按勾选集合 `S`（`S` 为空则整体拒绝，不执行任何命令）：

```
# 1. 拆出未跟踪集合 U = { p ∈ S : status === "?" }、已跟踪集合 T = S \ U
# 2. 对 T 里 index 状态 != 已暂存 的部分：git add -A -- <paths...>   （-A 才能正确处理删除）
# 3. 对 U：git add -- <paths...>
# 4. git commit -m <message> -- <paths in S>          # 不用 -a，路径限定天然避免误提交
# 5. 成功后：#beginRefresh()；失败：#commitError = errorMessage(error)
```

第 4 步的 `-- <paths>` 是关键安全阀：即便第 2/3 步因竞态多暂存了别的文件，`git commit -- <paths>` 也只提交 `S`。但它同时带来上面 1.3 说的 `session` scope 陷阱，所以 scope 门禁不是 UX 洁癖，是正确性要求。

一条真实的边界：重命名文件（`status === "R"`，`ChangeRecord.oldPath`，见 `src/contracts.ts:60-66`）在 `git commit -- <newPath>` 下需要额外把 `oldPath` 也放进路径列表，否则 Git 不会把它当 rename 处理而是「删一个加一个」。这是必须覆盖的测试用例。

### 1.5 确认 / dry-run / 错误回显 / 超时

三件套，缺一不可：

1. **确认**。`space` 勾选本身是低风险，但 `enter` 直接 commit 不可接受。复用 `pi-tui` 的 `overlays/ask-dialog.ts`（已有 `ExtensionAskDialogOption` / `ExtensionAskDialogResult`），或面板内自绘一个两行确认条。确认框必须显示：勾选文件数、`+N -M` 汇总、当前分支、以及 **detached HEAD 时明确警告**（`ProjectSnapshot.detachedAt` 已带这个信息，`src/contracts.ts:101`）。
2. **dry-run**。这是最值得做的一条，成本极低：`git commit --dry-run -- <paths>`（`--dry-run` 不产生提交，只报告「会提交哪些」）。在确认框里把 dry-run 的真实输出渲染给用户看，用户看到的是 Git 自己的结论而不是我们复述的推断。同时 dry-run 与真跑之间只隔一次确认，可以有效压缩 TOCTOU 窗口。
3. **错误回显**。`errorMessage()` 已做 `sanitizeTerminalText(...).replaceAll("\n", " ")`（`src/ui/files-panel.ts:146`），天然适配 footer 单行显示。新增 `#commitError` 字段 + footer 分支（照抄 `#branchError` 在 `:1935` 的写法）。

**超时**：`ProcessRunner` 没有超时概念（`src/git/process.ts:11-19`）。调用方自己建：

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("commit timed out after 60s")), 60_000);
timer.unref?.();   // 照抄 src/settings.ts:111 的做法
try { /* ... */ } finally { clearTimeout(timer); }
```

`BunProcessRunner` 在 abort 时会 `child.kill()`（`src/git/process.ts:86`），pre-commit hook 起的子进程一并死掉。但要注意 `child.kill()` 只杀直接子进程，hook 里 `npm`/`make` 派生的孙进程在 Windows 上可能留孤儿 —— 建议 hook 阶段**先不给超时**（给足 120s）或干脆在文档里声明「pre-commit hook 需自行限时」。

### 1.6 amend：只改 HEAD 提交标题（决策 D3 / D4）

范围严格限定为 `git commit --amend`，**不碰历史里更早的提交**。改任意历史提交的 message 需要 `rebase`/`filter-repo` 级历史重写，风险高一个数量级，不在本次范围。

**输入路径**：左栏切到 History 模式（`g`），选中**最新那条**（即 HEAD）记录，按 `u`（update message）打开消息输入框。键位可用性：`log` 模式已占用 `n/p/up/down/enter/right/l/tab/esc/?/j/k`，`u` 空闲，`C`（大写 shift+c）为备选。非 HEAD 记录按 `u` 时提示「only the latest commit can be amended here」，不静默无响应。

**三个必须处理的陷阱**：

1. **index 不干净会把暂存改动卷进 amend**。`git commit --amend` 会用当前 index 重建 commit，所以任何已暂存但未提交的文件都会被悄悄合进新 commit。提交前必须检查：
   ```
   git diff --cached --quiet HEAD     # exit 0 = index 与 HEAD 一树，安全
   ```
   不安全时**阻断**并提示「有已暂存改动，先处理或改用 commit」，绝不提供「一起卷进去」的选项。

2. **`-m` 只换 subject 会丢掉 body**。`git commit --amend -m "新标题"` 会把整个 message 替换成只有第一行，原 body 消失。正确做法：
   ```
   git log -1 --format=%B HEAD                    # 读完整 message
   → 拆成 subject（第一行）与 body（其余）
   → git commit --amend -m "<新 subject>" -m "<原 body>"      # body 为空时省略第二个 -m
   ```
   这是「改标题」与「改整个 message」的语义差别所在，必须有测试覆盖 body 保留。

3. **已推送的 HEAD 被 amend 后无法 push**。因为 D5 定为永不 force，所以后果是硬阻断：amend 一个已推送的 commit 后，`git push` 会被远端以 non-fast-forward 拒绝。缓解：amend 前查 upstream（`#upstream()` 复用），若 HEAD 已存在于远端（`git merge-base --is-ancestor HEAD <upstreamOid>` 为假即本地领先已推送历史之外），在确认框明确写「此提交已在 origin/main，amend 后需你在终端自行处理 push」。**不自动 force，也不自动 fetch**。

**勾选框不参与**（D4）。勾选集合只服务 `commit`；amend 只用上面那个消息输入框。左侧 `[x]` 显示不变，避免用户在 amend 语境下误以为勾选会影响 amend 结果。

**前置守卫**：`hasHead === false`（空仓库）时禁用；`detachedAt !== undefined` 时禁用（amend 会让该 commit 变孤儿）；`#commitController` 在飞时禁用。全部沿用 `#branchSwitching` 那套重入守卫 + generation 计数模式。

**hook**：`--amend` 会重跑 `pre-commit` 与 `commit-msg`。`commit-msg` 可能修改 message，导致用户刚输入的标题被改写。UI 上提供 `--no-verify` 开关（`commit` 也一并提供），并在 amend 完成后把最终 message 回显一次，让 hook 的改写可见。

### 1.7 commit / amend 的前置条件

1. 扩展 `src/git/status.ts` 支持暂存区感知（XY 解析或 porcelain v2）。
2. `src/git/repository.ts` 新增 `stage(paths, signal)` / `commit(message, paths, signal)` / `amend(subject, body, options, signal)` / `headMessage(signal)` / `indexMatchesHead(signal)`，并在 `src/review-source.ts:24-27` 的 `GitBackend` Pick 里加名字。
3. `src/contracts.ts` 扩 `ReviewSource`（`:156`）与 `ChangeRecord`（`:60`，加 `staged: boolean` 或拆 `indexStatus`/`worktreeStatus`），并新增 `CommitOptions`/`CommitResult`/`AmendOptions`/`AmendResult`/`PushOptions`/`PushResult`。
4. `src/ui/files-panel.ts` 新增 `#commitSelection` / `#commitError` / `#commitController` / `#amendController` + dispose 登记 + footer 分支 + `handleInput` 加 `space/x/A` + `log` 模式加 `u`。
5. `src/ui/presentation.ts` 的 `actionsFor()`（`:58`）与 `PANEL_HELP_GROUPS`（`:104`）补键位。
6. 确认 UI（ask-dialog 或自绘）与超时。

---

## 2. 结论二：push —— 有条件可行（风险最高）

### 2.1 与 commit 的差别

命令层没有额外难度（就是 `git push`），但**风险面大得多**，因为它触达仓库之外：远端网络、用户凭证、以及不可逆的 `refs` 变更。

### 2.2 必须解决的问题

| 问题 | 现状 | 处理 |
| --- | --- | --- |
| **无超时** | `src/git/process.ts:68` | push 是网络操作，**必须**加超时。60s 不够，建议可配置、默认 120s。这是 push 相比 commit 唯一不可省的加固 |
| **凭证提示会污染 stderr** | `commandFailure()`（`src/git/repository.ts:99`）把整段 stderr 拼进错误消息 | `git push` 失败时 stderr 可能含 `Username for 'https://github.com':` 等交互提示。必须先探测 TTY：无 TTY 时用 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=`/`SSH_ASKPASS` 置空，让 Git 快速失败而非挂住等输入。当前 `Bun.spawn`（`src/git/process.ts:79`）没有 `env` 透传入口，要改 `ProcessRunner.run` 签名或加 options |
| **push 会触发 watcher 风暴** | `src/git/watch.ts:194` 监听 `refs/`、`HEAD` | push 成功会写 `refs/remotes/*`，watcher 触发 `onChange` → `#beginRefresh()`。如果 push 期间有多次 ref 更新，会连续 refresh。需要复用 `#refreshQueued`（`src/ui/files-panel.ts:221`）做合并；`watch.ts` 对 `*.lock` 的过滤帮不上忙（`refs/*.lock` 已被忽略，但 `refs/remotes/...` 没有） |
| **没有 upstream 概念** | `src/git/repository.ts` 无 `rev-parse --abbrev-ref @{u}` | push 前必须先查 upstream；无 upstream 时要明确提示「先 push -u origin <branch>」而不是盲推 |
| **force 语义** | 无 | **v1 坚决不实现 force / force-with-lease**。这是不可逆操作，需要独立的二次确认设计（输入分支名），不应混在首版 |
| **commit 未完成时 push** | 无守卫 | `#commitController` 仍在飞时禁用 push 键 |
| **detached HEAD** | `ProjectSnapshot.detachedAt` 已带 | push 时必须显式警告，因为 push 的是某个匿名 commit，远端无法再被正常追踪 |

### 2.3 UX 设计：二次确认（决策 D1）

push 是决策 D1 明确要求的必做项，且**必须有二级确认**。一级确认不足以覆盖 push 的两个具体风险：推错分支（D5 已排除 force，所以推错分支的代价是不可撤回的远端 ref 变更）与推送过期内容（behind > 0）。

**前置信息采集**（进入确认前一次性算好，避免确认框里现算）：

```
git rev-parse --abbrev-ref --symbolic-full-name @{u}   # upstream，无输出/非 0 = 无 upstream
git rev-list --left-right --count <upstream>...HEAD    # 落后 N / 领先 M
git log --format=%h%x00%s <upstream>..HEAD              # 将要推送的提交列表
```

**第 1 级确认 —— 「看内容」**：渲染 `local main → origin/main`，`ahead M / behind N`，以及待推送提交列表（超过 10 条截断成 `… and N more`）。`behind > 0` 时整块用 error 色并写明「远端有新提交，先 pull/rebase」。此时只提供 `y`（继续）与 `esc`/`n`（取消）。这一步的作用是让用户确认「要推的内容」。

**第 2 级确认 —— 「写远端」**：渲染一行不可回退的声明 + 目标 ref 全名。
- 推非保护分支：按 `y` 执行。
- 推 `main` / `master` 或任何名字匹配 settings 里「受保护分支」列表的分支：**必须键入分支全名**才执行（`git push` 无法用 `--force`，但用分支名做确认本身是有价值的心理闸门）。
- `esc` / `n` 在第 2 级任意时刻取消，且取消状态不跨会话保留。

**执行期守卫**：`#pushController` 在飞时，`push` 键与 `commit` 键都禁用；`esc` **不**取消 push（避免误触导致半推状态），只允许关闭面板（`dispose` 会 abort，与 `#beginSwitchBranch` 一致）。超时默认 120s 可配置。

**流程全貌**：`space/x/A` 勾选 → `enter` 提交（第 1.5 节的确认 + dry-run）→ 提交成功后 footer 出现 `M commits to push · P push` → `P` → 第 1 级确认 → 第 2 级确认 → 执行 → footer 转为「已同步」。

**键位**：`p` 已被「上一项」占用（`:515`、`:569` 都用 `data === "p"`），所以 push 不能用 `p`。用 `P`（大写 shift+p，与 1.3 的 `A` 同策略）。

### 2.4 push 的前置条件

1. `ProcessRunner.run` 支持 env 与 stdin 关闭（`src/git/process.ts`）。
2. `GitRepository` 新增 `upstream(signal)` / `push(options, signal)` / `aheadBehind(upstream, signal)` / `pendingCommits(upstream, signal)`。
3. 决定 `GIT_TERMINAL_PROMPT` 等环境策略，并写进 README。
4. 实现超时 + `#pushError` + footer 提示 + 与 refresh 合并。
5. 实现 2.3 的两级确认状态机（新增 `#pushConfirm` 状态字段）。
6. **明确不构造 `--force` / `--force-with-lease`**，非 0 分支一律不出现该参数（要有测试断言）。

---

## 3. 结论三：本地缓存 —— 可行

### 3.1 现状：没有任何落盘状态

- `src/model/baseline.ts:49` `BaselineStore` 内部只有一个 `Map`（`:50`），**完全不落盘**。`clearSessionBaselines()`（`src/review-source.ts:398`）在 `session_shutdown` 时直接丢弃（`:403`）。
- 唯一落盘的是 `src/settings.ts` 的 `pi-lazygit.json`（`:42`），走 `getAgentDir()`（`:63-64`），且**所有读写失败都静默降级为默认值**（`:83-89`、`:145-148`）。
- `src/filesystem.ts` 的预览读取（`readProjectFilePreview`，`:157`）每次都走文件系统 + `MAX_PREVIEW_BYTES = 1_048_576` 上限。
- 面板自身有渲染层缓存：`RenderCache`（`src/ui/files-panel.ts:130`，按 width/rows/revision/theme 比对）+ `#diffRows` / `#wrappedDiff` / `#highlighted` 三层派生缓存，全部进程内。

所以「本地缓存」是**从零新增**，不是改造。

### 3.2 缓存对象：四个候选，按性价比排序

| 候选 | 缓存什么 | 收益 | 成本 | 建议 |
| --- | --- | --- | --- | --- |
| **A. 会话基线（session baseline）** | `BaselineStore` 的 `{status, sha256}` 序列化到磁盘 | **最高**。会话启动不用逐文件 `contentHash`（`src/git/repository.ts:576` 现在是 64KB 缓冲全文件读 sha256，大仓库首帧很慢） | 低。数据已经是不可变 `Object.freeze` 的 `Map`，直接 JSON 化 | **首推** |
| **B. 预览内容** | `FilePreview.lines` 按 (path, mtimeMs, size, kind) 缓存 | 高。切来切去不用反复 `git diff` | 中。要处理 1MB 级文本的序列化成本，得考虑只缓存 `kind: "text"` 且 `byteSize` 低于阈值的 | 次推 |
| **C. porcelain 状态快照** | `git status --porcelain=v1 -z` 的原始输出 | 低。命令本身就快，缓存收益被 watcher 抢先 | 中。失效逻辑复杂（必须和 HEAD / index 双双比对） | **不建议** |
| **D. 高亮结果** | `HighlighterStream` 的着色行 | 低。着色已在内存缓存里（`#highlighted.windowStart/End`，`src/ui/files-panel.ts:246-248`），落盘得不偿失 | 高 | **不建议** |

推荐 **A 打底 + B 可选**。C/D 不要做。

### 3.3 存储位置

跟 `pi-lazygit.json` 一致：`getAgentDir()` 下（`src/settings.ts:60-65` 已有懒加载 `getAgentDir` 的模式，直接复用）。但**不要塞进 `pi-lazygit.json`** —— 那是用户可读可手改的偏好文件，混入会让它在每个会话高频重写。分文件：

```
<getAgentDir()>/pi-lazygit.json          # 现有：偏好设置
<getAgentDir()>/pi-lazygit-cache/v1/     # 新增：缓存目录
  <sha256(canonicalRoot) 前 16 位>.json  # 每仓库一份
```

按 root 的哈希分文件而不是单文件，理由与 `src/model/baseline.ts:45` `baselineKey` 一致：多仓库会话不会互相踩，且单个损坏文件不影响其他。

**缓存不应进 `.git`**：项目 `.gitignore` 已忽略 `dist/`、`.tmp/`，但缓存的天然归属是用户 agent 目录（跨项目、不污染仓库、不需要用户手动清理）。

### 3.4 失效策略

三层，从便宜到贵：

1. **版本号**。目录名带 `v1`。结构变更时整目录失效，不做字段级迁移。
2. **仓库身份**。缓存内容必须记 `headIdentity`（`RepositoryInspection.headIdentity`，`src/git/repository.ts:41`；形态是 `branch:<name>` 或 `detached:<oid>`，见 `:388`、`:404`、`:407`）与 `canonicalRoot`（`src/review-source.ts:71-74`，Windows 下会 `toLowerCase()`）。两者任一不匹配 → 整份丢弃。**注意 `branch:<name>` 在同一分支上不会因为 commit 而变化**，所以它单独不够用，见第 3 点。
3. **内容指纹**。session baseline 缓存额外记 `headOid`（`git rev-parse HEAD`）与 `indexFingerprint`（`git ls-files --stage -z` 输出的 SHA-256，覆盖 mode、object ID、merge stage 和 NUL 分隔路径）。commit 后 `headOid` 变化会重建会话基线；stage 后索引指纹变化只失效磁盘 checkpoint，保留内存基线。不能在刷新中用 `git write-tree`：它即使禁用 optional locks 仍会重写 index，导致 watch → refresh → index 写入循环。查询禁用 `GIT_OPTIONAL_LOCKS`，`git diff` 还需用命令级 `-c diff.autoRefreshIndex=false` 禁用 stat-only 索引写入，不改仓库配置。
4. **mtime + size**（仅用于候选 B 预览缓存）。读取时 `stat` 比对，不一致就重取并回写。**不要**用 mtime 作为 session baseline 的依据 —— `BaselineStore` 的语义就是「会话开始时的内容哈希」，绕过内容哈希去信 mtime 会让漏检变更变成静默的假阴性。

### 3.5 原子写入与并发

现有代码里**没有**原子写的先例（`src/settings.ts:84` 是裸 `writeFile`）。缓存文件必须自己保证：

```ts
// 写 <file>.tmp-<pid> → fsync 可选 → rename(<file>.tmp-<pid>, <file>)
// POSIX rename 原子；Windows 上 node:fs.rename 在目标存在时会 EPERM/EXDEV，
// 需要先 unlink 目标（留一个极小的不可用窗口）或退回 rename-over 语义。
```

这一点在 Windows 上要专门测 —— 本项目的目标平台就是 Windows PowerShell / Windows Terminal（README `:11`）。

并发模型照抄 `src/review-source.ts:76-86` 的 `coordinatorFor` + `WeakMap<BaselineStore, BaselineCoordinator>`：每个 store 一个 `AbortController` 加一个 `captures: Map<string, Promise<void>>` 去重表，保证同一 `(root, headIdentity)` 的捕获只跑一次。同时补一条：捕获进行中时的读请求要么等它完成（`waitForCaller`，`src/review-source.ts:88-118`），要么读到旧值 —— 但**不能**读一个写到一半的文件，所以读侧也必须走「临时文件存在才可见」的规则。

失败降级照抄 `src/settings.ts:83-89` 的哲学：**缓存是优化，不是正确性来源**。任何缓存层的读写失败都必须静默回落到实时计算，绝不能让面板打不开。已有现成判据可复用 —— `src/contracts.ts:156` `ReviewSource.refresh()` 的调用方（`src/review-source.ts:284-318`）已经在处理「基线未建立」的错误，新增缓存失败应走同一条路：不抛错，只是不命中。

### 3.6 与 BaselineStore / SettingsStore 的关系

- `BaselineStore` 保持**内存权威**。落盘只做「启动时预热」：构造后立刻从磁盘读，读到就 `#baselines.set(...)`，之后所有语义不变。这样 `capture/compare/get/clear`（`src/model/baseline.ts:52-126`）四个方法一行不用改，风险最低。**这是首推方案 A 的关键理由。**
- `SettingsStore` 不动。缓存的 schema 版本走缓存目录名（3.3 第 1 点），不进用户偏好文件。

### 3.7 缓存的前置条件

1. `src/model/baseline.ts` 加 `serialize(root, headIdentity)` / `hydrate(json)`，内部仍是 `Map`。
2. `src/review-source.ts` 的 `#establishInspectedBaseline`（`:194`）在 `capture` 前先尝试 hydrate；`headOid` / `indexFingerprint` 不匹配则跳过并覆盖。
3. 一个新的 `src/model/cache-store.ts` 承担路径解析、原子写、schema 版本、损坏文件清理。
4. `src/review-source.ts:398` `clearSessionBaselines()` 保留现有丢弃语义，但**在丢弃前把当前基线写回磁盘**（会话结束是天然的检查点）。

---

## 4. 模块映射

### 需要改造的现有文件

| 文件 | commit / 勾选 | push | 缓存 | 关键改动点 |
| --- | --- | --- | --- | --- |
| `src/contracts.ts` | ✅ | ✅ | ✅ | `ChangeRecord`（`:60`）加暂存信息；`ReviewSource`（`:156`）加 `stage/commit/upstream/push`；新增 `CommitResult`/`PushResult` |
| `src/git/status.ts` | ✅ | — | — | `parsePorcelainV1Z`（`:80`）拆 XY 两列，或新增 v2 解析器 |
| `src/git/repository.ts` | ✅ | ✅ | ✅ | 新增 `stage`/`commit`/`upstream`/`push`/`headOid`；复用 `run()`（`:356`）、`commandFailure()`（`:99`）、`ensureComplete()`（`:106`） |
| `src/git/process.ts` | ✅ | ✅ | — | `Bun.spawn`（`:79`）加 `env` 透传与 `stdin: "ignore"`；`ProcessRunner`（`:11`）接口扩 options |
| `src/review-source.ts` | ✅ | ✅ | ✅ | `GitBackend` Pick（`:24`）加方法；`#establishInspectedBaseline`（`:194`）接 hydrate；`clearSessionBaselines()`（`:398`）加回写 |
| `src/model/baseline.ts` | — | — | ✅ | 加 `serialize`/`hydrate`，`capture/compare/get/clear`（`:52-126`）不改 |
| `src/ui/files-panel.ts` | ✅ | ✅ | — | `#commitSelection`/`#commitError`/`#commitController`/`#pushError`；`#renderTreeRow`（`:1746`）加勾选槽；`handleInput`（`:303`）加 `space/x/A`；`dispose()`（`:463`）登记 controller；`#footer()`（`:1892`）加分支 |
| `src/ui/presentation.ts` | ✅ | ✅ | — | `actionsFor()`（`:58`）+ `PANEL_HELP_GROUPS`（`:104`）补键位 |
| `src/settings.ts` | — | — | ✅ | 不改语义；仅复用 `getAgentDir()` 的懒加载模式（`:60`） |
| `src/index.ts` | ✅ | ✅ | ✅ | 若需要面板外命令（如 `/commit`），在 `registerCommand`（`:156`）旁加；`notify` 用于跨面板提示 |

### 建议新增的文件

| 文件 | 职责 | 预估 |
| --- | --- | --- |
| `src/git/commit.ts` | `stage` / `commit` 的参数编排（拆 `?` 与已跟踪、rename 的 `oldPath` 合并、路径分批） | ~150 行 |
| `src/git/push.ts` | `upstream` / `push` + 超时 + 凭证环境策略 | ~120 行 |
| `src/model/cache-store.ts` | 缓存路径、schema 版本、原子写、损坏清理 | ~150 行 |
| `src/ui/commit-dialog.ts` | 提交确认条 / 消息输入（可复用 `pi-tui` `Input` 与 `overlays/ask-dialog.ts`） | ~200 行 |
| `src/model/commit-selection.ts` | 勾选集合的纯函数（toggle / selectAll / deselectAll / prune / scope 门禁），便于单测 | ~80 行 |

预估实现总量 **700-900 行**，测试另算（现有测试密度很高：非测试代码约 18,500 行对应 230 个测试）。

---

## 5. 与 lazygit 的功能划分对照

| lazygit 能力 | 本项目现状 | 差距 | 建议 |
| --- | --- | --- | --- |
| 文件列表 + `space` 切换暂存 | 有文件列表，无暂存切换 | **本项目的 1.3 需求，恰好与 lazygit 一致** | 做 |
| 暂存区 / 工作区两个分组 | 有 `workspace`/`session` 两个 scope | 概念相近但语义不同（session 是内容哈希基线，不是暂存区） | 不强行对齐，命名保持现状 |
| 提交面板（消息 + amend + 保留暂存选项） | 无 | 消息输入、amend、`--no-verify` | v1 只做消息 + 提交；amend 放 v2 |
| `push` / `pull` / `force-with-lease` | 无 | 远端交互全套 | v1 只做保守 push 或仅提示；force 明确不做 |
| `M` 查看提交、`p` 局部暂存行 | 有 commit 历史（`:116` README 段、`:559` `history()`） | 无行级暂存 | 行级/块级暂存（`git apply --cached`）成本不低，排 v3 |
| reflog / stash / tag / undo | 无 | 全缺 | 与本次需求无关，不排期 |
| fetch + 远端分支跟踪 | 无 | 无 | 若做 push 顺带考虑最小 fetch |
| 冲突解决 | 无 | — | 与本次需求无关 |

对照结论：本项目定位是**只读审阅面板**，lazygit 是**写操作工作台**。commit + 勾选是「审阅顺手提交」的最小增量，与定位相容；把 push/force/stash/行级暂存全搬进来就变成第二个 lazygit 了。建议守住「审阅为主、提交为辅」的边界。

---

## 6. 风险清单

### commit / 勾选

1. **`git commit -- <paths>` 把路径上的历史改动一并提交**（session scope 下尤其明显）。缓解：scope 门禁（只允许 workspace），确认框里用 `git commit --dry-run` 的真实输出做二次校验。
2. **勾选状态与真实 index 漂移**。用户在面板里勾好文件，去终端改了 index，回来 commit 的对象已不是勾选时的快照。缓解：commit 前重新读一次 status，勾选项若已不在改动集则从集合剔除并在确认框里标红；用 dry-run 兜底。
3. **pre-commit hook 挂死或改文件**。hook 失败 → commit 失败（好）；hook 成功但 `git add` 改动文件 → 用户看到的 diff 与刚审阅的不一致（坏，且难察觉）。缓解：commit 成功回调里强制 `#beginRefresh()`，并在 footer 显示新的 `+N -M`，让漂移可见。
4. **重命名文件被拆成 delete+add**（`oldPath` 未纳入路径列表）。缓解：`src/git/commit.ts` 统一收集 `record.oldPath`，测试用例覆盖 rename。
5. **大勾选集的命令行长度上限**。Windows 上命令行长度有 32K 限制，几千个文件会超。缓解：分批 `git add`（每批 200 路径）；勾选上限设 2000，超出时在确认框提示改用 `git commit -a` + 预先 `git reset` 的全量路径。
6. **amend 静默卷走已暂存改动**（1.6 陷阱 1）。缓解：amend 前跑 `git diff --cached --quiet HEAD`，不干净就阻断，不提供「一起卷进去」选项。
7. **amend 丢 body**（1.6 陷阱 2）。缓解：`git log -1 --format=%B` 拆分后用两个 `-m` 回填，测试断言 body 原样保留。

### amend

1. **`commit-msg` hook 改写用户刚输入的标题**。缓解：提供 `--no-verify` 开关；amend 完成后回显最终 message。
2. **已推送的 HEAD 被 amend 后 push 被拒**。缓解：amend 前查 upstream 并在确认框声明后果（D5 不 force，所以这是硬阻断而非自动修复）；不自动 fetch 以免引入网络副作用。
3. **detached HEAD 上 amend 制造孤儿 commit**。缓解：`detachedAt !== undefined` 时硬阻断。

### push

1. **无超时导致面板假死**。缓解：调用方 timer + `BunProcessRunner` 的 `child.kill()`（`src/git/process.ts:86`）；Windows 上孙进程可能残留，需在文档声明。
2. **凭证交互把面板挂在等输入上**。缓解：`GIT_TERMINAL_PROMPT=0` + 空 `GIT_ASKPASS`，让 Git 秒失败；错误消息里明确提示「请在终端完成认证」。
3. **误推 / 推错分支**。缓解：push 前必须查到 upstream，不匹配则拒绝并显示 `local → remote` 两端名；**永不 force**。
4. **push 期间 watcher 风暴**。缓解：`#refreshQueued`（`src/ui/files-panel.ts:221`）合并 refresh；push 进行中临时 `#stopWatch()`，结束后 `#installWatch()`（照抄 `#beginSwitchBranch` 在 `:1238`/`:1260` 的做法）。
5. **detached HEAD 上 push**。缓解：`detachedAt` 存在时硬阻断，必须先切分支。
6. **二级确认被「连按两下 y」绕过**。缓解：两级确认必须使用**不同的确认键**（第 1 级 `y`、第 2 级默认 `y` 但要求一次 `esc` 之外的新事件序列，或直接对受保护分支强制输入分支名）；第 2 级进入时必须清空任何残留输入缓冲，并有单测断言「第 1 级按 y 不会直接执行 push」。

### 本地缓存

1. **缓存陈旧导致漏检变更**。最危险的一种，因为它不报错。缓解：失效键包含 `headOid` + `indexFingerprint`（3.4 第 3 点），不用 mtime 做内容判断；提供 `pi-lazygit-cache` 一键清空，并在 `?` 帮助里写明。
2. **缓存文件损坏 / 版本升级**。缓解：`v1` 目录名 + 解析失败静默丢弃（照 `src/settings.ts:145-148`）；损坏文件顺手 unlink。
3. **Windows 原子写 rename 失败**。缓解：3.5 的 unlink-then-rename；Windows 上专门测试。
4. **隐私**：会话基线哈希与文件路径落盘 = 项目文件名泄露到磁盘。缓解：目录权限 0700（`mkdir` 的 `mode`，Windows 上无效但无害）；提供显式关闭开关。
5. **缓存与 watcher 竞态**：watch 触发 refresh 时 hydrate 正在写。缓解：`coordinatorFor` 的 `captures` 去重表（`src/review-source.ts:76-86`）覆盖读侧，读临时文件而非目标文件。

### 全局

- **产品定位漂移**。README `:267` 的 "Scope and safety" 与 `:128` 的 "Switching a branch writes to your repository. It is the only operation in this plugin that does." 会在加入 commit/push 后变成**错误声明**。缓解：见第 8 节。
- **`package.json` 的 `files` 白名单**。`files` 数组（18 个条目）显式列出要发布的 `src` 文件，新增的 5 个模块不加进去就不会进 npm 包，运行时 `import` 直接失败（而且本地开发因为有源码所以测不出来）。缓解：见第 8 节。

---

## 7. 分阶段落地顺序与可测判据

### 阶段 1：勾选 + commit + amend（不含 push、不含缓存）

范围：`src/contracts.ts`、`src/git/status.ts`、`src/git/repository.ts`、`src/git/process.ts`、`src/review-source.ts`、`src/model/commit-selection.ts`、`src/git/commit.ts`、`src/ui/files-panel.ts`、`src/ui/presentation.ts`、`src/ui/commit-dialog.ts`

判据（全部可在本地断言）：

1. `bun run typecheck` exit 0。
2. `bun test` 不回归（基线 230 pass / 0 fail），且新增测试 ≥ 12 条，覆盖：勾选集合的 toggle/全选/反选/prune、`?` 与已跟踪的拆分、rename 的 `oldPath` 合并、空集合拒绝、session scope 禁用、命令分批。
3. 单条集成测试可断言：`bun test src/git/repository.integration.test.ts` 中新增用例在一个临时仓库里执行「勾 2 个文件 → commit → `git rev-list --count HEAD` 从 0 变 1、`git show --name-only` 只含这 2 个路径」。
4. dry-run 判据：确认框渲染的内容来自 `git commit --dry-run` 的 stdout（测试里用 fake `ProcessRunner` 断言参数序列）。
5. **amend 判据（决策 D3）**：新增测试 ≥ 6 条 —— (a) index 不干净时 amend 被拒绝且不改动仓库；(b) subject 变更后 `git log -1 --format=%s` 等于新标题；(c) **body 原样保留**（`%b` 与 amend 前逐字相等）；(d) detached HEAD / 空仓库时 amend 被拒绝；(e) 非 HEAD 记录触发 `u` 不执行 amend；(f) 生成的 argv 里不含 `--force`。
6. 手动判据：在临时仓库里跑 `bun` + omp，按 `space` 勾选后 `enter`，确认框出现，`n` 取消、`y` 提交，footer 出现新 `+N -M`；再按一次 `space` 取消勾选，确认框拒绝执行。切到 History 选中最新一条按 `u` 改标题，退出后 `git log -1 --format=%s` 正确且 body 未丢。

### 阶段 2：本地缓存（只做候选 A：会话基线）

范围：`src/model/cache-store.ts`、`src/model/baseline.ts`、`src/review-source.ts`

判据：

1. `bun run typecheck` exit 0；`bun test` 不回归，新增测试 ≥ 8 条：序列化往返一致、`headOid` 不匹配则失效、`indexFingerprint` 不匹配则失效、损坏 JSON 静默丢弃、写入中途崩溃不产生半截目标文件（读侧只见完整文件）、并发捕获只跑一次。
2. 冷/热启动判据：在临时仓库里连续两次跑同一会话，`clearSessionBaselines()` 后重新 hydrate，第二次的 `refresh()` 不再触发逐文件 `contentHash`（测试里用计数 fake `hashFile` 断言调用次数从 N 降到 0）。
3. 跨平台判据：Windows 下 `atomic write` 测试通过（rename-over 目标已存在的情形必须有用例）。
4. **与 amend/commit 的交互判据**：commit 或 amend 之后 `headOid` 变化 → 缓存自动失效并重建，不得把旧基线套用到新 HEAD 上。

### 阶段 3：push（决策 D1 必做，含二级确认）

范围：`src/git/process.ts`（env/stdin）、`src/git/repository.ts`、`src/git/push.ts`、`src/ui/files-panel.ts`、`src/ui/presentation.ts`

判据：

1. `bun run typecheck` exit 0；`bun test` 不回归，新增测试 ≥ 12 条：无 upstream 拒绝、detached HEAD 拒绝、commit 在飞时拒绝、超时 abort、force 参数永不出现（非 0 分支一律不构造 `--force`/`--force-with-lease`）、凭证环境变量被设上、push 期间 stop watch、结束后 reinstall watch。
2. **二级确认判据**：单测断言「第 1 级按 `y` 不会触发 `push()` 调用，只会进入第 2 级」；`behind > 0` 时第 1 级渲染 error 块且 `esc` 取消；对 `main`/`master` 第 2 级必须匹配输入的分支全名才执行，空输入与错误输入都拒绝。
3. 非 0 分支判据：对着一个不存在的远端 `git push` 一次，面板必须在超时内返回可读错误（「认证请在终端完成」之类），不挂死、不留下孤儿进程。
4. 手动判据：对一个真实仓库 push 到本地 bare 远端成功，两级确认走通，footer 提示转为「已同步」。

---

## 8. 文档与发布影响

改动落地时必须同步的**具体位置**：

1. `README.md:267` — `## Scope and safety`。现文：`Pi Files Review is read-only except for one explicit action: switching to a local branch with Enter in the branch list... It also does not... stage changes, apply or revert hunks, commit, fetch, stash, force, or create, rename, or delete any ref.` 加入 commit 后这段的**每一个否定句都会变成错误声明**。
2. `README.md:128` — `## Switching branches` 下的加粗句 `Switching a branch writes to your repository. It is the only operation in this plugin that does.` 必须改写。
3. `README.md:138` `## Keys` 及 `:236` `## Review modes and scopes` — 补勾选/commit 键位，并说明勾选态不持久化、session scope 不可提交。
4. `README.md:256` `## Limits` — 补 commit/amend/push 超时、路径分批、amend 不支持历史旧提交、force 不支持。
5. `package.json` 的 `files` 数组（18 条，其中 17 条是 `src/...`）— 必须补 `src/git/commit.ts`、`src/git/push.ts`、`src/model/cache-store.ts`、`src/ui/commit-dialog.ts`、`src/model/commit-selection.ts`，否则发布后运行时 import 失败。
6. `package.json` 的 `version`（当前 `0.6.7`）与 README 的安装/版本说明；按仓库既有惯例（`git log` 里 `Release 0.6.6`、`feat 升级版本号0.6.0`）走一次版本提交。
7. `src/ui/presentation.ts:104` `PANEL_HELP_GROUPS` 与 `README.md:138` 的键位表必须一致 —— 这是本仓库现有的一致性约束（`:58` `actionsFor()` 与帮助面板共用同一份 `PanelAction`）。

---

## 9. 开放问题

已确认的见第 0 节决策记录（D1-D5）。仍然开放：

1. **要不要行级/块级暂存？** lazygit 的 `p` 键。本报告按 v3 排（`git apply --cached`），但如果这是核心需求，阶段 1 就要重新设计勾选模型（行级勾选会把 `Set<string>` 换成更复杂的状态结构）。
2. **缓存默认开还是默认关？** 隐私敏感场景建议默认开但提供开关（`src/settings.ts` 加 `cacheEnabled`）。
3. **`pi-lazygit-cache` 的清理入口**：跟着缓存自动淘汰（如 7 天 / 500 个仓库上限），还是只在设置里给一个「清空缓存」动作？
4. **二级确认的受保护分支清单**：2.3 暂定 `main`/`master` 强制输入分支全名。这个清单是否需要做成 settings 可配置项，还是硬编码足够？
5. **amend 是否也提供 `--no-verify` 开关**，还是只在确认框里显示 hook 警告而不管它？

## 10. 落地状态

以下记录依据最终接口、代码与主线验收证据，不改变 0–9 节的原始设计记录。

### D1–D5

| 决策 | 最终实现 | 与设计稿的偏差 |
| --- | --- | --- |
| D1：push 二次确认 | `P` 展示 push plan；`y` 进入第二阶段。普通分支按 `w`，受保护分支必须键入完整分支名并按 `Enter`。落后于 upstream 时阻断；执行前拒绝已过期计划并绑定计划中的准确 upstream/branch。 | 阶段二键位是 `w`（不是设计稿的两阶段都按 `y`）；额外对 stale plan、多 push URL 及 tag/传输惊讶失败关闭。 |
| D2：已跟踪默认勾选 | workspace change list 的 Modified files 可提交文件默认勾选，No version files 默认不勾选；`space`/`x`/`A` 可手动选择。 | 刷新保留手动选择；切换 scope 与提交后重新应用默认值；选择不持久化，session scope 禁止提交。 |
| D3：仅改 HEAD 标题 | History 中 `u` 编辑 HEAD subject；原 body 原样保留。dirty index、unborn/detached HEAD 阻断。 | amend 的 `--no-verify` 可用 `Ctrl+N` 切换；不支持修改更早提交。 |
| D4：amend 与勾选独立 | amend 不读取或更改 commit selection。 | 无。 |
| D5：永不 force | push 参数不含 force；已推送的 amend 不自动改写远端历史。 | 无。 |

### 配置、缓存与边界

- `commitTimeoutMs` 与 `pushTimeoutMs` 默认各 120000ms；`protectedBranches` 默认 `main`、`master`，配置值添加到固定保护分支集合，不能移除这两个默认保护项。
- `cacheEnabled` 默认开启；`/files-cache on|off` 切换，`/clear-cache` 清理当前项目条目。文件位于 OMP agent dir 下的 `pi-lazygit-cache/v1`，以规范化仓库根、HEAD identity/OID、index fingerprint 作身份；损坏、schema 不符或身份不匹配的缓存不命中。命中缓存可省去 baseline capture 的逐文件哈希，但每次 refresh 仍对工作树内容哈希并与会话基线比较，不能以 mtime 代替内容校验。工作树变化不使基线失效；HEAD 变化会重新捕获会话起点。仅 index 变化时清除磁盘 checkpoint、递增缓存 generation，但保留内存基线，避免暂存/dry-run 隐藏此前的改动。关闭缓存会清理当前项目条目并抑制待写入；关闭状态下 session shutdown 不落盘。
- Git add path sets are staged in batches of 200, including rename old paths, but the final path-limited commit passes the full selected path list; exceptionally large selections can still exceed the OS command-line limit. Dry-run stages selected paths before its report, so cancelling afterward leaves them staged. This differs from the design's intuitive description of dry-run as preview-only and is the actual Git behavior.
- 推送不弹出认证提示：HTTPS 禁用终端提示并使用非交互凭据助手；默认 SSH 使用 BatchMode。现有自定义 SSH transport 必须显式支持 OpenSSH `BatchMode=yes` 或 plink `-batch`，否则失败关闭；多 push URL、额外 tag/传输行为也拒绝。Windows 超时杀 Git 直接子进程不保证杀掉 hook 派生的孙进程。
- ahead/behind 基于本地最近已知的 remote-tracking refs；面板不自动 fetch。应在面板外 fetch 更新计数，真实 push 仍由 Git 拒绝 non-fast-forward。无 upstream 时显示不可执行的计划，不能进入写入确认；实际 push 拒绝无 upstream。

### 第 9 节开放问题答复

1. 行/块暂存未实现；仅按整个文件选择。
2. 缓存默认开启，且可经设置关闭。
3. 提供 `/clear-cache` 清理当前项目缓存；未采用按天数/仓库数淘汰。
4. 受保护分支列表可经 `protectedBranches` 配置，默认 `main`、`master`。
5. commit/amend 均支持 `Ctrl+N` 切换 `--no-verify`。

### 验证证据

- `bun run typecheck`：主线在最终边界修复后运行，exit 0，无 TypeScript 诊断。
- `bun test`：主线完整回归，331 pass / 0 fail，6086 expect() calls，21 个测试文件，exit 0。
- Git 实仓 smoke：空 HEAD commit 改标题保留多段/空白 body；路径限定 dry-run/commit 不夹带未选暂存文件；dirty-index amend 拒绝；不同名 upstream 精确推送；upstream 漂移拒绝，全部 exit 0。
- 缓存实盘/接线 smoke：冷捕获哈希 1 次、命中后捕获 0 次、实时 compare 仍哈希 1 次；between-session 工作树编辑可见；index 漂移和 fingerprint 失败保留内存基线；Windows 现有目标原子替换、损坏缓存回退、嵌套目录清理与 shutdown 防回填，全部 exit 0。
- 面板真实 Git smoke：勾选、空选择/session 门禁、粘贴、提前确认竞态、no-verify、commit/amend、受保护分支独立二阶段 push、重复确认清空、失败后 watcher 恢复均通过；12/40/100 列宽度未越界，exit 0。
- 受保护分支输入的实仓边界补充：在 `main` 中间删除字符后确认，不发生远端写入；修复字符后才能推送成功，exit 0。
- 真实 OMP 18.4.12 宿主：在隔离仓库打开 `/files`，观察默认勾选文件行和真实 Git dry-run 确认；明确确认后提交成功。`P`/`y` 展示独立的受保护分支写入确认，键入 `main` 后真实本地 bare remote 的 `refs/heads/main` 收到提交；本地和远端 `git log -1 --format=%s` 均返回 `native host acceptance commit`。
- `npm pack` 与解包导入 smoke：`pi-lazygit-0.7.0.tgz` 实际包含全部 23 个声明文件；发布入口和 5 个新模块在已安装 peer dependencies 下均可导入，exit 0。