import { expect, test } from "bun:test";
import { changeMap, emptySummary } from "./contracts";

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
