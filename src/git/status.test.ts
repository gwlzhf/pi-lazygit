import { expect, test } from "bun:test";
import { GitOutputError, parsePorcelainV1Z } from "./status";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

test("parses ordinary, untracked, Unicode, spaced, and v1 -z rename records", () => {
  const records = parsePorcelainV1Z(
    encode(" M src/a.ts\0R  新 name.ts\0old name.ts\0?? untracked file.ts\0"),
  );

  expect(records.get("src/a.ts")).toEqual({
    path: "src/a.ts",
    index: " ",
    worktree: "M",
    status: "M",
  });
  expect(records.get("新 name.ts")).toEqual({
    path: "新 name.ts",
    oldPath: "old name.ts",
    index: "R",
    worktree: " ",
    status: "R",
  });
  expect(records.get("untracked file.ts")).toMatchObject({
    path: "untracked file.ts",
    status: "?",
  });
});

test("maps every unmerged status pair to U", () => {
  const pairs = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
  const records = parsePorcelainV1Z(
    encode(pairs.map((pair, index) => `${pair} conflict-${index}.ts\0`).join("")),
  );

  for (const [index, pair] of pairs.entries()) {
    expect(records.get(`conflict-${index}.ts`)).toMatchObject({
      index: pair[0],
      worktree: pair[1],
      status: "U",
    });
  }
});

test("normalizes current and original path separators", () => {
  const records = parsePorcelainV1Z(
    encode("R  src\\new name.ts\0src\\old name.ts\0 M test\\next.ts\0"),
  );

  expect([...records.keys()]).toEqual(["src/new name.ts", "test/next.ts"]);
  expect(records.get("src/new name.ts")?.oldPath).toBe("src/old name.ts");
});

test("accepts rename source filenames that resemble a following status record", () => {
  const records = parsePorcelainV1Z(encode("R  new.ts\0 M next.ts\0"));

  expect([...records.keys()]).toEqual(["new.ts"]);
  expect(records.get("new.ts")).toMatchObject({
    oldPath: " M next.ts",
    status: "R",
  });
});

test("consumes copy source paths and classifies copies as additions", () => {
  const records = parsePorcelainV1Z(
    encode("C  copied.ts\0source.ts\0 M following.ts\0"),
  );

  expect(records.get("copied.ts")).toMatchObject({
    oldPath: "source.ts",
    status: "A",
  });
  expect(records.get("following.ts")?.status).toBe("M");
});

test("applies display precedence for non-conflict status pairs", () => {
  const records = parsePorcelainV1Z(
    encode("RM renamed.ts\0old.ts\0AD deleted.ts\0AM added.ts\0 T typed.ts\0"),
  );

  expect(records.get("renamed.ts")?.status).toBe("R");
  expect(records.get("deleted.ts")?.status).toBe("D");
  expect(records.get("added.ts")?.status).toBe("A");
  expect(records.get("typed.ts")?.status).toBe("M");
});

test("rejects malformed records without consuming a following path", () => {
  const malformed = [
    " M missing-terminator.ts",
    "M short-header.ts\0",
    "R  missing-old.ts\0",
    "ZZ unknown-status.ts\0",
    " M \0",
  ];

  for (const output of malformed) {
    expect(() => parsePorcelainV1Z(encode(output))).toThrow(GitOutputError);
  }
});

test("rejects invalid UTF-8 with a descriptive Git output error", () => {
  const invalid = new Uint8Array([0x20, 0x4d, 0x20, 0xff, 0x00]);

  expect(() => parsePorcelainV1Z(invalid)).toThrow(/UTF-8/i);
});
