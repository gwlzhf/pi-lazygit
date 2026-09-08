import { expect, test } from "bun:test";
import {
  changeMap,
  DIFF_CONTEXT_LEVELS,
  diffContextLabel,
  emptySummary,
  FULL_DIFF_CONTEXT,
  isDiffLayout,
  nextDiffContext,
  normalizeDiffContext,
} from "./contracts";

test("changeMap normalizes separators and keys by current path", () => {
  const map = changeMap([
    { path: "src\\a.ts", index: " ", worktree: "M", status: "M" },
  ]);

  expect([...map.keys()]).toEqual(["src/a.ts"]);
  expect(map.get("src/a.ts")?.path).toBe("src/a.ts");
});

test("emptySummary returns independent zeroed values", () => {
  expect(emptySummary()).toEqual({ files: 0, insertions: 0, deletions: 0 });
  expect(emptySummary()).not.toBe(emptySummary());
});

test("diff context helpers cycle the supported levels and reject anything else", () => {
  expect(DIFF_CONTEXT_LEVELS).toEqual([3, 10, 25, FULL_DIFF_CONTEXT]);
  expect(nextDiffContext(3)).toBe(10);
  expect(nextDiffContext(25)).toBe(FULL_DIFF_CONTEXT);
  expect(nextDiffContext(FULL_DIFF_CONTEXT)).toBe(3);
  // An unknown level restarts the cycle instead of getting stuck.
  expect(nextDiffContext(7)).toBe(3);

  expect(normalizeDiffContext(10)).toBe(10);
  expect(normalizeDiffContext(4)).toBeUndefined();
  expect(normalizeDiffContext("3")).toBeUndefined();
  expect(normalizeDiffContext(undefined)).toBeUndefined();

  expect(diffContextLabel(3)).toBe("3");
  expect(diffContextLabel(FULL_DIFF_CONTEXT)).toBe("full");
});

test("isDiffLayout accepts only the two supported layouts", () => {
  expect(isDiffLayout("unified")).toBe(true);
  expect(isDiffLayout("split")).toBe(true);
  expect(isDiffLayout("columns")).toBe(false);
  expect(isDiffLayout(undefined)).toBe(false);
});
