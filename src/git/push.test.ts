import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PUSH_TIMEOUT_MS,
  MAX_PUSH_PLAN_COMMITS,
  NON_INTERACTIVE_ENV,
  parseAheadBehind,
  parseUpstreamFields,
  pushArgv,
} from "./push";

describe("parseUpstreamFields", () => {
  test("reads the remote name and the tracking ref git resolved", () => {
    expect(parseUpstreamFields("origin\0refs/remotes/origin/main\n")).toEqual({
      remote: "origin",
      trackingRef: "refs/remotes/origin/main",
    });
  });

  test("keeps a slash inside a remote name intact", () => {
    expect(parseUpstreamFields("my-host/team\0refs/remotes/my-host/team/feature/ui")).toEqual({
      remote: "my-host/team",
      trackingRef: "refs/remotes/my-host/team/feature/ui",
    });
  });

  test("returns nothing when the branch tracks nothing", () => {
    expect(parseUpstreamFields("")).toBeUndefined();
    expect(parseUpstreamFields("\0refs/remotes/origin/main")).toBeUndefined();
    expect(parseUpstreamFields("origin\0")).toBeUndefined();
  });
  test("selects only the current branch from multi-branch output", () => {
    expect(
      parseUpstreamFields(
        "refs/heads/other\0other\0refs/heads/unrelated\n" +
          "refs/heads/main\0origin\0refs/heads/release\n",
        "main",
      ),
    ).toEqual({ remote: "origin", trackingRef: "refs/heads/release" });
  });
});

describe("parseAheadBehind", () => {
  test("reads the left-right counts in the right order", () => {
    expect(parseAheadBehind("3\t7\n")).toEqual({ ahead: 7, behind: 3 });
  });

  test("accepts spaces as the separator", () => {
    expect(parseAheadBehind("0 0")).toEqual({ ahead: 0, behind: 0 });
  });

  test("rejects malformed counts instead of guessing", () => {
    expect(() => parseAheadBehind("")).toThrow(TypeError);
    expect(() => parseAheadBehind("x\t1")).toThrow(TypeError);
    expect(() => parseAheadBehind("1")).toThrow(TypeError);
    expect(() => parseAheadBehind("1.5\t2")).toThrow(TypeError);
  });
});

describe("pushArgv", () => {
  test("spells out the refspec so the push cannot follow a renamed upstream", () => {
    expect(pushArgv("origin", "main", "refs/heads/release")).toEqual([
      "push",
      "--no-follow-tags",
      "--",
      "origin",
      "refs/heads/main:refs/heads/release",
    ]);
  });

  test("exposes no way to reach a force push", () => {
    const argv = pushArgv("origin", "main", "refs/heads/main");

    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("--force-with-lease");
    expect(argv).not.toContain("-f");
    expect(argv).not.toContain("+refs/heads/main:refs/heads/main");
  });
});

describe("NON_INTERACTIVE_ENV", () => {
  test("disables terminal prompts so a push cannot block on credentials", () => {
    expect(NON_INTERACTIVE_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(NON_INTERACTIVE_ENV.GIT_ASKPASS).toBe("");
    expect(NON_INTERACTIVE_ENV.SSH_ASKPASS).toBe("");
  });
});

test("a push has a bounded default timeout", () => {
  expect(Number.isSafeInteger(DEFAULT_PUSH_TIMEOUT_MS)).toBe(true);
  expect(DEFAULT_PUSH_TIMEOUT_MS).toBeGreaterThan(0);
});

test("the push confirmation list is bounded", () => {
  expect(MAX_PUSH_PLAN_COMMITS).toBeGreaterThan(0);
});