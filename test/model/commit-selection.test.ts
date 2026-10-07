import { expect, test } from "bun:test";
import type { ChangeRecord, StatusCode } from "../../src/contracts";
import { CommitSelection, canCommit } from "../../src/model/commit-selection";

function change(path: string, status: StatusCode = "M"): ChangeRecord {
  return { path, index: " ", worktree: status, status };
}

test("initial selection defaults to tracked changes and permits opting in untracked files", () => {
  const selection = new CommitSelection();
  selection.initialize([change("a"), change("temporary", "?"), change("conflict", "U")]);

  expect(selection.selectedPaths()).toEqual(new Set(["a"]));
  expect(selection.toggle("conflict")).toBe(false);
  expect(selection.has("conflict")).toBe(false);
  expect(selection.has("temporary")).toBe(false);
  expect(selection.toggle("temporary")).toBe(true);
  selection.initialize([change("a"), change("temporary", "?"), change("new-temp", "?")]);
  expect(selection.selectedPaths()).toEqual(new Set(["a", "temporary"]));
  selection.reset([change("a"), change("temporary", "?")]);
  expect(selection.selectedPaths()).toEqual(new Set(["a"]));
});

test("toggle and invert update one path without changing other selection", () => {
  const selection = new CommitSelection();
  selection.initialize([change("a"), change("b")]);

  expect(selection.toggle("a")).toBe(false);
  expect(selection.invert("b")).toBe(false);
  expect(selection.size).toBe(0);
  expect(selection.invert("a")).toBe(true);
  expect(selection.has("a")).toBe(true);
});

test("select all and clear operate on the supplied selection", () => {
  const selection = new CommitSelection();
  selection.selectAll(["a", "b"]);
  expect(selection.selectedPaths()).toEqual(new Set(["a", "b"]));

  selection.clear();
  expect(selection.size).toBe(0);
});

test("prune removes stale selections and known paths", () => {
  const selection = new CommitSelection();
  selection.initialize([change("a"), change("b")]);
  selection.prune(["b"]);

  expect(selection.selectedPaths()).toEqual(new Set(["b"]));
  selection.initialize([change("a"), change("b")]);
  expect(selection.selectedPaths()).toEqual(new Set(["a", "b"]));
});

test("reinitializing the active scope preserves explicit choices and selects new paths", () => {
  const selection = new CommitSelection();
  selection.initialize([change("a"), change("b")]);
  selection.toggle("a");
  selection.initialize([change("a"), change("b"), change("c")]);

  expect(selection.selectedPaths()).toEqual(new Set(["b", "c"]));
});

test("uncommittable paths are excluded when initializing or resetting", () => {
  const selection = new CommitSelection();
  selection.initialize([change("conflict", "U"), change("file")]);
  selection.reset([change("conflict", "U"), change("remaining")]);

  expect(selection.selectedPaths()).toEqual(new Set(["remaining"]));
});

test("selected paths are returned as an isolated view", () => {
  const selection = new CommitSelection();
  selection.initialize([change("a")]);
  const view = selection.selectedPaths() as Set<string>;
  view.clear();

  expect(selection.has("a")).toBe(true);
});

test("only a nonempty workspace selection can commit", () => {
  expect(canCommit("workspace", 1)).toBe(true);
  expect(canCommit("workspace", 0)).toBe(false);
  expect(canCommit("session", 1)).toBe(false);
});
