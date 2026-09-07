import {
  type ChangeRecord,
  type StatusCode,
  normalizeProjectPath,
} from "../contracts";

const CONFLICT_PAIRS: Readonly<Record<string, true>> = {
  DD: true,
  AU: true,
  UD: true,
  UA: true,
  DU: true,
  AA: true,
  UU: true,
};
const ORDINARY_STATUS: Readonly<Record<string, true>> = {
  " ": true,
  M: true,
  A: true,
  D: true,
  R: true,
  C: true,
  T: true,
};

export class GitOutputError extends Error {
  override readonly name = "GitOutputError";

  constructor(message: string) {
    super(message);
  }
}

function decodeOutput(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new GitOutputError(`Git status output is not valid UTF-8${detail}`);
  }
}

function validatePair(pair: string, recordNumber: number): void {
  if (pair === "??" || CONFLICT_PAIRS[pair] === true) return;
  const index = pair[0];
  const worktree = pair[1];
  if (
    index === undefined ||
    worktree === undefined ||
    ORDINARY_STATUS[index] !== true ||
    ORDINARY_STATUS[worktree] !== true ||
    pair === "  " ||
    index === "U" ||
    worktree === "U"
  ) {
    throw new GitOutputError(
      `Malformed Git status record ${recordNumber}: unsupported status pair ${JSON.stringify(pair)}`,
    );
  }
}

function displayStatus(pair: string): StatusCode {
  if (CONFLICT_PAIRS[pair] === true) return "U";
  if (pair === "??") return "?";
  if (pair.includes("R")) return "R";
  if (pair.includes("D")) return "D";
  if (pair.includes("A") || pair.includes("C")) return "A";
  return "M";
}

export function parsePorcelainV1Z(bytes: Uint8Array): Map<string, ChangeRecord> {
  if (bytes.byteLength === 0) return new Map();
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new GitOutputError("Malformed Git status output: missing final NUL terminator");
  }

  const fields = decodeOutput(bytes).split("\0");
  fields.pop();
  const records = new Map<string, ChangeRecord>();

  for (let cursor = 0, recordNumber = 1; cursor < fields.length; recordNumber += 1) {
    const field = fields[cursor];
    if (field === undefined || field.length < 4 || field[2] !== " ") {
      throw new GitOutputError(
        `Malformed Git status record ${recordNumber}: expected "XY path" before NUL`,
      );
    }

    const pair = field.slice(0, 2);
    validatePair(pair, recordNumber);
    const rawPath = field.slice(3);
    if (rawPath.length === 0) {
      throw new GitOutputError(`Malformed Git status record ${recordNumber}: path is empty`);
    }

    const index = pair[0] as string;
    const worktree = pair[1] as string;
    const path = normalizeProjectPath(rawPath);
    const hasOriginalPath =
      index === "R" || index === "C" || worktree === "R" || worktree === "C";

    let oldPath: string | undefined;
    if (hasOriginalPath) {
      const original = fields[cursor + 1];
      if (original === undefined || original.length === 0) {
        throw new GitOutputError(
          `Malformed Git status record ${recordNumber}: rename/copy source path is missing`,
        );
      }
      oldPath = normalizeProjectPath(original);
      cursor += 1;
    }

    const base = {
      path,
      index,
      worktree,
      status: displayStatus(pair),
    } satisfies ChangeRecord;
    records.set(path, oldPath === undefined ? base : { ...base, oldPath });
    cursor += 1;
  }

  return records;
}
