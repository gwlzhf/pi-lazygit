import { expect, test } from "bun:test";
import type { ChangeRecord, StatusCode } from "../contracts";
import {
  buildTree,
  flattenTree,
  recoverSelection,
  visiblePaths,
} from "./tree";

function change(
  path: string,
  status: StatusCode,
  oldPath?: string,
): ChangeRecord {
  return oldPath === undefined
    ? { path, index: status, worktree: " ", status }
    : { path, oldPath, index: status, worktree: " ", status };
}

function changes(...records: readonly ChangeRecord[]): Map<string, ChangeRecord> {
  return new Map(records.map((record) => [record.path, record]));
}

test("buildTree orders directories before files without losing display casing", () => {
  const records = changes(
    change("src/a.ts", "M"),
    change("src/Auth/z.ts", "U"),
    change("src/NewName.ts", "R", "src/old-name.ts"),
    change("README.md", "A"),
  );

  const root = buildTree(
    ["README.md", "src/a.ts", "src\\Auth\\z.ts", "src/NewName.ts"],
    records,
  );

  expect(root).toMatchObject({ kind: "directory", name: "", path: "", status: "U" });
  expect(root.children.map((node) => node.name)).toEqual(["src", "README.md"]);

  const src = root.children[0]!;
  expect(src).toMatchObject({ kind: "directory", name: "src", path: "src", status: "U" });
  expect(src.children.map((node) => node.name)).toEqual([
    "Auth",
    "a.ts",
    "NewName.ts",
  ]);
  expect(src.children[0]?.path).toBe("src/Auth");
  expect(src.children[0]?.children[0]).toMatchObject({
    kind: "file",
    name: "z.ts",
    path: "src/Auth/z.ts",
    status: "U",
  });
  expect(src.children[2]).toMatchObject({ path: "src/NewName.ts", status: "R" });

  expect(Object.isFrozen(root)).toBe(true);
  expect(Object.isFrozen(root.children)).toBe(true);
  expect(Object.isFrozen(src)).toBe(true);
  expect(Object.isFrozen(src.children)).toBe(true);
});

test("buildTree propagates the highest-precedence descendant status", () => {
  const records = changes(
    change("priority/m.ts", "M"),
    change("priority/untracked.ts", "?"),
    change("priority/added.ts", "A"),
    change("priority/deleted.ts", "D"),
    change("priority/renamed.ts", "R", "priority/old.ts"),
    change("priority/conflicted.ts", "U"),
  );

  const root = buildTree([...records.keys()], records);
  expect(root.status).toBe("U");
  expect(root.children[0]?.status).toBe("U");

  const withoutConflict = new Map(records);
  withoutConflict.delete("priority/conflicted.ts");
  expect(buildTree([...withoutConflict.keys()], withoutConflict).status).toBe("R");

  withoutConflict.delete("priority/renamed.ts");
  expect(buildTree([...withoutConflict.keys()], withoutConflict).status).toBe("D");
});

test("visiblePaths selects current changed paths in modified mode and every file in all mode", () => {
  const records = changes(
    change("src\\a.ts", "M"),
    change("src/NewName.ts", "R", "src/old-name.ts"),
  );
  const allFiles = ["README.md", "src\\a.ts", "src/NewName.ts", "src/Auth/z.ts"];

  expect(visiblePaths(allFiles, records, "modified")).toEqual([
    "src/a.ts",
    "src/NewName.ts",
  ]);
  expect(visiblePaths(allFiles, records, "all")).toEqual([
    "README.md",
    "src/a.ts",
    "src/NewName.ts",
    "src/Auth/z.ts",
  ]);
});

test("flattenTree omits the synthetic root and follows directory expansion", () => {
  const root = buildTree(
    ["README.md", "src/a.ts", "src/Auth/z.ts"],
    changes(change("src/a.ts", "M")),
  );

  const collapsed = flattenTree(root, new Set());
  expect(collapsed.map(({ node, depth, expanded }) => [node.path, depth, expanded])).toEqual([
    ["src", 0, false],
    ["README.md", 0, false],
  ]);

  const expanded = flattenTree(root, new Set(["src", "src/Auth"]));
  expect(expanded.map(({ node, depth, expanded: isExpanded }) => [node.path, depth, isExpanded])).toEqual([
    ["src", 0, true],
    ["src/Auth", 1, true],
    ["src/Auth/z.ts", 2, false],
    ["src/a.ts", 1, false],
    ["README.md", 0, false],
  ]);
  expect(Object.isFrozen(expanded)).toBe(true);
  expect(expanded.every(Object.isFrozen)).toBe(true);
});

test("empty input produces an immutable empty tree and no rows", () => {
  const root = buildTree([], new Map());

  expect(root).toEqual({
    kind: "directory",
    name: "",
    path: "",
    children: [],
  });
  expect(Object.isFrozen(root)).toBe(true);
  expect(Object.isFrozen(root.children)).toBe(true);
  expect(flattenTree(root, new Set())).toEqual([]);
});

test("buildTree rejects empty, absolute, and parent-traversal paths", () => {
  for (const path of ["", "/rooted.txt", "C:\\rooted.txt", "../outside", "src/../../outside"]) {
    expect(() => buildTree([path], new Map())).toThrow();
  }
});

test("buildTree validates the authoritative change-record path", () => {
  const invalidRecord = change("", "M");
  const records = new Map<string, ChangeRecord>([["src/a.ts", invalidRecord]]);

  expect(() => buildTree(["src/a.ts"], records)).toThrow();
});

test("recoverSelection prefers a surviving path and otherwise clamps the old index", () => {
  const rows = flattenTree(
    buildTree(["a.ts", "b.ts", "c.ts"], new Map()),
    new Set(),
  );

  expect(recoverSelection(rows, "b.ts", 0)).toBe(1);
  expect(recoverSelection(rows, "missing.ts", 99)).toBe(2);
  expect(recoverSelection(rows, undefined, -4)).toBe(0);
  expect(recoverSelection([], "a.ts", 0)).toBe(-1);
});
