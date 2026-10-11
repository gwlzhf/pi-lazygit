import { describe, expect, test } from "bun:test";
import type { ChangeRecord, StatusCode } from "../../src/contracts";
import { PATH_BATCH_SIZE } from "../../src/git/commit";
import { revertInvocations } from "../../src/git/revert";
import { revertPlan, summarizeRevert } from "../../src/model/revert-plan";

function change(path: string, status: StatusCode, overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    path,
    index: status === "?" ? "?" : " ",
    worktree: status,
    status,
    ...overrides,
  };
}

function selection(...records: readonly ChangeRecord[]): Map<string, ChangeRecord> {
  return new Map(records.map(record => [record.path, record]));
}

describe("revertPlan", () => {
  test("restores a tracked change and deletes an untracked one", () => {
    const plan = revertPlan(selection(change("src/a.ts", "M"), change("docs/b.md", "?")));

    expect(plan.restore).toEqual(["src/a.ts"]);
    expect(plan.remove).toEqual(["docs/b.md"]);
    expect(plan.unindex).toEqual([]);
    expect(plan.paths).toEqual(["docs/b.md", "src/a.ts"]);
  });

  test("restores a deleted path from HEAD rather than deleting anything", () => {
    const plan = revertPlan(selection(change("src/a.ts", "D")));

    expect(plan.restore).toEqual(["src/a.ts"]);
    expect(plan.remove).toEqual([]);
  });

  test("takes a staged addition out of the index instead of restoring it", () => {
    const plan = revertPlan(selection(change("src/new.ts", "A", { index: "A", worktree: " " })));

    expect(plan.restore).toEqual([]);
    expect(plan.unindex).toEqual(["src/new.ts"]);
    expect(plan.remove).toEqual(["src/new.ts"]);
  });

  test("puts a rename back where it was and deletes its new name", () => {
    const plan = revertPlan(selection(change("src/new.ts", "R", { index: "R", oldPath: "src/old.ts" })));

    expect(plan.restore).toEqual(["src/old.ts"]);
    expect(plan.unindex).toEqual(["src/new.ts"]);
    expect(plan.remove).toEqual(["src/new.ts"]);
  });

  test("drops unmerged paths, which have no single committed state", () => {
    const plan = revertPlan(selection(change("src/a.ts", "U", { index: "U", worktree: "U" }), change("src/b.ts", "M")));

    expect(plan.paths).toEqual(["src/b.ts"]);
  });

  test("normalizes separators and orders case-insensitively", () => {
    const plan = revertPlan(selection(change("Src/B.ts", "M"), change("src\\a.ts", "M")));

    expect(plan.restore).toEqual(["src/a.ts", "Src/B.ts"]);
  });

  test("reports nothing for an empty selection", () => {
    expect(revertPlan(new Map())).toEqual({ restore: [], unindex: [], remove: [], paths: [] });
  });
});

describe("revertInvocations", () => {
  test("restores tracked paths from HEAD and cleans only untracked ones", () => {
    const invocations = revertInvocations(
      revertPlan(selection(change("src/a.ts", "M"), change("docs/b.md", "?"))),
      { hasHead: true },
    );

    expect(invocations.map(invocation => invocation.argv)).toEqual([
      ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", "src/a.ts"],
      ["--literal-pathspecs", "clean", "-q", "-f", "--", "docs/b.md"],
    ]);
  });

  test("never asks clean to reach an ignored file", () => {
    const argv = revertInvocations(
      revertPlan(selection(change("dist/bundle.js", "?"))),
      { hasHead: true },
    ).flatMap(invocation => invocation.argv);

    expect(argv).not.toContain("-x");
    expect(argv).not.toContain("-ff");
  });

  test("removes an addition outright when there is no commit to restore from", () => {
    const invocations = revertInvocations(
      revertPlan(selection(change("src/new.ts", "A", { index: "A", worktree: " " }))),
      { hasHead: false },
    );

    expect(invocations.map(invocation => invocation.argv)).toEqual([
      ["--literal-pathspecs", "rm", "-q", "-f", "--", "src/new.ts"],
      ["--literal-pathspecs", "clean", "-q", "-f", "--", "src/new.ts"],
    ]);
  });

  test("batches long selections so one command line stays within the limit", () => {
    const many = Array.from({ length: PATH_BATCH_SIZE + 1 }, (_, index) => change(`src/${index}.ts`, "M"));
    const invocations = revertInvocations(revertPlan(selection(...many)), { hasHead: true });
    const restores = invocations.filter(invocation => invocation.argv[1] === "restore");

    expect(restores).toHaveLength(2);
    expect(restores[0]?.argv).toHaveLength(6 + PATH_BATCH_SIZE);
  });

  test("runs nothing for a selection with no revertible path", () => {
    expect(revertInvocations(revertPlan(new Map()), { hasHead: true })).toEqual([]);
  });
});

describe("summarizeRevert", () => {
  test("counts a staged addition once, as a deletion rather than an untracked file", () => {
    const summary = summarizeRevert(
      revertPlan(selection(change("src/new.ts", "A", { index: "A", worktree: " " }))),
    );

    // The path is both unindexed and removed, so a naive bucket count would
    // report it twice and call it an untracked file.
    expect(summary.total).toBe(1);
    expect(summary.discarded).toEqual(["src/new.ts"]);
    expect(summary.deleted).toEqual([]);
  });

  test("keeps a genuinely untracked file out of the discarded count", () => {
    const summary = summarizeRevert(revertPlan(selection(change("docs/b.md", "?"))));

    expect(summary.total).toBe(1);
    expect(summary.discarded).toEqual([]);
    expect(summary.deleted).toEqual(["docs/b.md"]);
  });

  test("splits a mixed selection without double counting", () => {
    const summary = summarizeRevert(
      revertPlan(
        selection(
          change("src/a.ts", "M"),
          change("src/new.ts", "A", { index: "A", worktree: " " }),
          change("docs/b.md", "?"),
        ),
      ),
    );

    expect(summary.total).toBe(3);
    expect(summary.discarded).toEqual(["src/a.ts", "src/new.ts"]);
    expect(summary.deleted).toEqual(["docs/b.md"]);
  });

  test("counts a rename's new name once, beside the name it is put back under", () => {
    const summary = summarizeRevert(
      revertPlan(selection(change("src/new.ts", "R", { index: "R", oldPath: "src/old.ts" }))),
    );

    expect(summary.total).toBe(2);
    expect(summary.discarded).toEqual(["src/new.ts", "src/old.ts"]);
    expect(summary.deleted).toEqual([]);
  });
});