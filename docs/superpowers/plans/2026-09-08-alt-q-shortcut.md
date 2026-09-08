# Alt+Q Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the files review panel shortcut `Ctrl+Shift+G` with `Alt+Q` without changing `/files` or panel behavior.

**Architecture:** Keep the existing `FILES_SHORTCUT` constant as the single registration value. Change that value, its contract assertion, and the user-facing documentation; do not add compatibility aliases or another registration.

**Tech Stack:** TypeScript, Bun test runner, Oh My Pi extension API.

## Global Constraints

- Register exactly `alt+q` through `pi.registerShortcut`.
- Do not register or retain `ctrl+shift+g`.
- Keep `/files` unchanged.
- Preserve the shared `openFileReview` handler and all existing panel behavior.

---

### Task 1: Replace the files review shortcut

**Files:**
- Modify: `src/index.test.ts:140-154`
- Modify: `src/index.ts:20`
- Modify: `README.md:46-53`

**Interfaces:**
- Consumes: `ExtensionAPI.registerShortcut(shortcut, options)` and the existing exported `FILES_SHORTCUT` constant.
- Produces: `FILES_SHORTCUT` with the exact value `"alt+q"`; `/files` and the shortcut continue to invoke `openFileReview`.

- [ ] **Step 1: Update the registration contract test**

Change the test name and shortcut assertion in `src/index.test.ts`:

```ts
test("registers /files, Alt+Q, and session lifecycle handlers", () => {
  const harness = createApiHarness();
  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel,
  })(harness.api);

  expect(harness.commands.get("files")?.description).toContain("files");
  expect(harness.shortcuts.get(FILES_SHORTCUT)).toBeDefined();
  expect(FILES_SHORTCUT).toBe("alt+q");
  expect(harness.lifecycle.get("session_start")).toBeDefined();
  expect(harness.lifecycle.get("session_shutdown")).toBeDefined();
});
```

- [ ] **Step 2: Run the focused test and verify the contract fails**

Run:

```powershell
bun test src/index.test.ts --test-name-pattern "registers /files, Alt\\+Q"
```

Expected: FAIL because `FILES_SHORTCUT` is still `"ctrl+shift+g"` instead of `"alt+q"`.

- [ ] **Step 3: Change the registered shortcut**

Change `src/index.ts` to:

```ts
export const FILES_SHORTCUT = "alt+q";
```

Do not add a second `registerShortcut` call or preserve the old value.

- [ ] **Step 4: Update the user-facing shortcut documentation**

Change the shortcut entry under `README.md` → `Open the panel` to:

```markdown
- `Alt+Q`
```

Keep the `/files` entry and surrounding behavior description unchanged.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```powershell
bun test src/index.test.ts --test-name-pattern "registers /files, Alt\\+Q"
```

Expected: PASS; the extension registration map contains `alt+q` through `FILES_SHORTCUT`.

- [ ] **Step 6: Run complete verification**

Run:

```powershell
bun run check
```

Expected: TypeScript type checking and all Bun tests pass.

- [ ] **Step 7: Commit the implementation**

```powershell
git add src/index.ts src/index.test.ts README.md
git commit -m "feat: open files review with Alt+Q"
```
