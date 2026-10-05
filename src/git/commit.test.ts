import { describe, expect, test } from "bun:test";
import type { ChangeRecord, StatusCode } from "../contracts";
import {
  assertCommitMessage,
  commitArgv,
  PATH_BATCH_SIZE,
  planCommit,
  stageInvocations,
} from "./commit";

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

describe("planCommit", () => {
  test("splits untracked paths from tracked ones", () => {
    const plan = planCommit(
      selection(change("src/a.ts", "M"), change("docs/b.md", "?")),
    );

    expect(plan.tracked).toEqual(["src/a.ts"]);
    expect(plan.untracked).toEqual(["docs/b.md"]);
    expect(plan.paths).toEqual(["docs/b.md", "src/a.ts"]);
  });

  test("adds the rename source so the commit records a rename", () => {
    const plan = planCommit(
      selection(change("src/new.ts", "R", { index: "R", oldPath: "src/old.ts" })),
    );

    expect(plan.paths).toEqual(["src/new.ts", "src/old.ts"]);
  });

  test("drops unmerged paths, which git refuses to commit", () => {
    const plan = planCommit(
      selection(change("src/a.ts", "U", { index: "U", worktree: "U" }), change("src/b.ts", "M")),
    );

    expect(plan.paths).toEqual(["src/b.ts"]);
  });

  test("normalizes separators and orders case-insensitively", () => {
    const plan = planCommit(selection(change("Src/B.ts", "M"), change("src\\a.ts", "M")));

    expect(plan.paths).toEqual(["src/a.ts", "Src/B.ts"]);
  });

  test("reports nothing for an empty selection", () => {
    expect(planCommit(new Map())).toEqual({ tracked: [], untracked: [], paths: [] });
  });
});

describe("stageInvocations", () => {
  test("uses -A for tracked paths so deletions are recorded", () => {
    const invocations = stageInvocations(planCommit(selection(change("src/a.ts", "D"))));

    expect(invocations).toEqual([{ argv: ["--literal-pathspecs", "add", "-A", "--", "src/a.ts"] }]);
  });

  test("uses a plain add for untracked paths", () => {
    const invocations = stageInvocations(planCommit(selection(change("docs/b.md", "?"))));

    expect(invocations).toEqual([{ argv: ["--literal-pathspecs", "add", "--", "docs/b.md"] }]);
  });

  test("batches paths so a Windows command line cannot overflow", () => {
    const many = Array.from({ length: PATH_BATCH_SIZE * 2 + 1 }, (_, index) =>
      change(`src/file-${String(index)}.ts`, "M"),
    );
    const invocations = stageInvocations(planCommit(selection(...many)));

    expect(invocations).toHaveLength(3);
    expect(invocations.map(invocation => invocation.argv.length)).toEqual([
      PATH_BATCH_SIZE + 4,
      PATH_BATCH_SIZE + 4,
      5,
    ]);
    for (const invocation of invocations) {
      expect(invocation.argv.slice(0, 4)).toEqual(["--literal-pathspecs", "add", "-A", "--"]);
    }
  });

  test("emits nothing when there is nothing to stage", () => {
    expect(stageInvocations(planCommit(new Map()))).toEqual([]);
  });
});

describe("commitArgv", () => {
  test("limits the commit to the given paths and never uses --all", () => {
    const argv = commitArgv("fix: thing", ["src/a.ts", "src/b.ts"]);

    expect(argv).toEqual(["--literal-pathspecs", "commit", "-m", "fix: thing", "--", "src/a.ts", "src/b.ts"]);
    expect(argv).not.toContain("-a");
    expect(argv).not.toContain("--all");
  });

  test("adds --dry-run and --no-verify only when asked", () => {
    expect(commitArgv("m", ["a.ts"], { dryRun: true, noVerify: true })).toEqual([
      "--literal-pathspecs",
      "commit",
      "--dry-run",
      "--no-verify",
      "-m",
      "m",
      "--",
      "a.ts",
    ]);
    expect(commitArgv("m", ["a.ts"])).not.toContain("--dry-run");
    expect(commitArgv("m", ["a.ts"])).not.toContain("--no-verify");
  });
});


describe("assertCommitMessage", () => {
  test("trims the message git will store", () => {
    expect(assertCommitMessage("  feat: add push  \n")).toBe("feat: add push");
  });

  test("rejects a blank message before anything is staged", () => {
    expect(() => assertCommitMessage("   \n\t ")).toThrow(TypeError);
  });
});