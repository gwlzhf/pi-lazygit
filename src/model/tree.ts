import type { ChangeRecord, StatusCode, ViewMode } from "../contracts";
import { normalizeProjectPath } from "../contracts";

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

interface AssemblyNode {
  kind: "directory" | "file";
  name: string;
  path: string;
  status: StatusCode | undefined;
  children: Map<string, AssemblyNode>;
}

const STATUS_PRECEDENCE: Readonly<Record<StatusCode, number>> = {
  M: 1,
  "?": 2,
  A: 2,
  D: 3,
  R: 4,
  U: 5,
};

function normalizeTreePath(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:(?:\/|$)/.test(normalized)
  ) {
    throw new TypeError(`Project path must be non-empty and relative: ${path}`);
  }

  const segments = normalized.split("/");
  if (segments.includes("..")) {
    throw new TypeError(`Project path must not traverse its parent: ${path}`);
  }

  const compact = segments.filter((segment) => segment.length > 0 && segment !== ".");
  if (compact.length === 0) {
    throw new TypeError(`Project path must identify a file: ${path}`);
  }
  return compact.join("/");
}

function compareNodes(left: AssemblyNode, right: AssemblyNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;

  const folded = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  return folded || left.name.localeCompare(right.name);
}

function higherStatus(
  current: StatusCode | undefined,
  candidate: StatusCode | undefined,
): StatusCode | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;

  const difference = STATUS_PRECEDENCE[candidate] - STATUS_PRECEDENCE[current];
  if (difference > 0 || (difference === 0 && candidate === "A" && current === "?")) {
    return candidate;
  }
  return current;
}

function freezeNode(node: AssemblyNode): TreeNode {
  const children = [...node.children.values()].sort(compareNodes).map(freezeNode);
  let status = node.status;
  if (node.kind === "directory") {
    status = undefined;
    for (const child of children) status = higherStatus(status, child.status);
  }

  const frozenChildren = Object.freeze(children);
  if (status === undefined) {
    return Object.freeze({
      kind: node.kind,
      name: node.name,
      path: node.path,
      children: frozenChildren,
    });
  }
  return Object.freeze({
    kind: node.kind,
    name: node.name,
    path: node.path,
    status,
    children: frozenChildren,
  });
}

export function buildTree(
  paths: readonly string[],
  changes: ReadonlyMap<string, ChangeRecord>,
): TreeNode {
  const statusByPath = new Map<string, StatusCode>();
  for (const record of changes.values()) {
    const recordPath = normalizeTreePath(record.path);
    statusByPath.set(recordPath, record.status);
  }

  const root: AssemblyNode = {
    kind: "directory",
    name: "",
    path: "",
    status: undefined,
    children: new Map(),
  };
  const normalizedPaths = paths.map(normalizeTreePath);

  for (const path of normalizedPaths) {
    const segments = path.split("/");
    let parent = root;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const childPath = segments.slice(0, index + 1).join("/");
      const kind = index === segments.length - 1 ? "file" : "directory";
      const existing = parent.children.get(name);
      if (existing !== undefined && existing.kind !== kind) {
        throw new TypeError(`Project path is both a file and directory: ${childPath}`);
      }

      const child: AssemblyNode = existing ?? {
        kind,
        name,
        path: childPath,
        status: kind === "file" ? statusByPath.get(childPath) : undefined,
        children: new Map(),
      };
      parent.children.set(name, child);
      parent = child;
    }
  }

  return freezeNode(root);
}

export function flattenTree(
  root: TreeNode,
  expanded: ReadonlySet<string>,
): readonly TreeRow[] {
  const rows: TreeRow[] = [];

  const appendChildren = (parent: TreeNode, depth: number): void => {
    for (const node of parent.children) {
      const isExpanded = node.kind === "directory" && expanded.has(node.path);
      rows.push(Object.freeze({ node, depth, expanded: isExpanded }));
      if (isExpanded) appendChildren(node, depth + 1);
    }
  };

  appendChildren(root, 0);
  return Object.freeze(rows);
}

export function visiblePaths(
  allFiles: readonly string[],
  changes: ReadonlyMap<string, ChangeRecord>,
  mode: ViewMode,
): readonly string[] {
  const source = mode === "all"
    ? allFiles
    : [...changes.values()].map((record) => record.path);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of source) {
    const normalized = normalizeTreePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return Object.freeze(result);
}

export function recoverSelection(
  rows: readonly TreeRow[],
  previousPath: string | undefined,
  previousIndex: number,
): number {
  if (rows.length === 0) return -1;

  if (previousPath !== undefined) {
    const normalizedPreviousPath = normalizeProjectPath(previousPath);
    const survivingIndex = rows.findIndex(({ node }) => node.path === normalizedPreviousPath);
    if (survivingIndex >= 0) return survivingIndex;
  }

  const finiteIndex = Number.isFinite(previousIndex) ? Math.trunc(previousIndex) : 0;
  return Math.min(Math.max(finiteIndex, 0), rows.length - 1);
}
