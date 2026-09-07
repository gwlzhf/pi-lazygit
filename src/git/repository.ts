import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINES,
  type ChangeRecord,
  type ChangeSummary,
  type FilePreview,
  normalizeProjectPath,
} from "../contracts";
import {
  readProjectFilePreview,
  resolveProjectFile,
  validateProjectPath,
} from "../filesystem";
import {
  BunProcessRunner,
  type CommandOutput,
  type ProcessRunner,
} from "./process";
import { GitOutputError, parsePorcelainV1Z } from "./status";

const SMALL_GIT_OUTPUT = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface RepositoryInspection {
  readonly root: string;
  readonly hasHead: boolean;
  readonly allFiles: readonly string[];
  readonly changes: ReadonlyMap<string, ChangeRecord>;
  readonly summaryByPath: ReadonlyMap<
    string,
    { readonly insertions: number; readonly deletions: number }
  >;
  readonly summary: ChangeSummary;
}

function abortError(reason: unknown): DOMException {
  const error = new DOMException("The operation was aborted", "AbortError");
  if (reason !== undefined) Object.defineProperty(error, "cause", { value: reason });
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function decodeGitOutput(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new GitOutputError(`${description} is not valid UTF-8${detail}`);
  }
}

function stripGitLineTerminator(text: string): string {
  if (!text.endsWith("\n")) return text;
  const withoutLineFeed = text.slice(0, -1);
  return withoutLineFeed.endsWith("\r")
    ? withoutLineFeed.slice(0, -1)
    : withoutLineFeed;
}

function commandFailure(args: readonly string[], output: CommandOutput): GitOutputError {
  const detail = output.stderr.trim();
  return new GitOutputError(
    `git ${args.join(" ")} failed with exit code ${output.exitCode}${detail ? `: ${detail}` : ""}`,
  );
}

function ensureComplete(args: readonly string[], output: CommandOutput): void {
  if (output.truncated) {
    throw new GitOutputError(`git ${args.join(" ")} exceeded its output limit`);
  }
  if (output.exitCode !== 0) throw commandFailure(args, output);
}

function compareCaseInsensitive(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseNulPaths(bytes: Uint8Array): string[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new GitOutputError("Malformed git ls-files output: missing final NUL terminator");
  }
  const fields = decodeGitOutput(bytes, "git ls-files output").split("\0");
  fields.pop();
  const unique = new Set<string>();
  for (const field of fields) {
    if (field.length === 0) throw new GitOutputError("Malformed git ls-files output: empty path");
    unique.add(normalizeProjectPath(field));
  }
  return [...unique].sort(compareCaseInsensitive);
}

function parseNumstatValue(
  value: string,
  label: string,
  recordNumber: number,
): number {
  if (value === "-") return 0;
  if (!/^\d+$/u.test(value)) {
    throw new GitOutputError(
      `Malformed git diff --numstat -z record ${recordNumber}: invalid ${label}`,
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new GitOutputError(
      `Malformed git diff --numstat -z record ${recordNumber}: ${label} exceeds the safe integer range`,
    );
  }
  return parsed;
}

function parseNumstatZ(
  bytes: Uint8Array,
): Map<string, { readonly insertions: number; readonly deletions: number }> {
  if (bytes.byteLength === 0) return new Map();
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new GitOutputError(
      "Malformed git diff --numstat -z output: missing final NUL terminator",
    );
  }
  const fields = decodeGitOutput(bytes, "git diff --numstat -z output").split("\0");
  fields.pop();
  const summaries = new Map<
    string,
    { readonly insertions: number; readonly deletions: number }
  >();

  for (let cursor = 0, recordNumber = 1; cursor < fields.length; recordNumber += 1) {
    const header = fields[cursor];
    if (header === undefined) break;
    cursor += 1;
    const firstTab = header.indexOf("\t");
    const secondTab = header.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      throw new GitOutputError(
        `Malformed git diff --numstat -z record ${recordNumber}: expected insertion and deletion counts`,
      );
    }
    const rawInsertions = header.slice(0, firstTab);
    const rawDeletions = header.slice(firstTab + 1, secondTab);
    if (
      (rawInsertions === "-") !== (rawDeletions === "-")
    ) {
      throw new GitOutputError(
        `Malformed git diff --numstat -z record ${recordNumber}: binary counts must both be \"-\"`,
      );
    }
    const inlinePath = header.slice(secondTab + 1);
    let currentPath = inlinePath;
    if (inlinePath.length === 0) {
      const oldPath = fields[cursor];
      currentPath = fields[cursor + 1] ?? "";
      if (oldPath === undefined || oldPath.length === 0) {
        throw new GitOutputError(
          `Malformed git diff --numstat -z rename record ${recordNumber}: original path is missing`,
        );
      }
      if (currentPath.length === 0) {
        throw new GitOutputError(
          `Malformed git diff --numstat -z rename record ${recordNumber}: current path is missing`,
        );
      }
      cursor += 2;
    }
    const path = normalizeProjectPath(currentPath);
    if (summaries.has(path)) {
      throw new GitOutputError(
        `Malformed git diff --numstat -z output: duplicate current path ${JSON.stringify(path)}`,
      );
    }
    summaries.set(path, {
      insertions: parseNumstatValue(rawInsertions, "insertion count", recordNumber),
      deletions: parseNumstatValue(rawDeletions, "deletion count", recordNumber),
    });
  }
  return summaries;
}

function reconcileRenameSummaries(
  changes: ReadonlyMap<string, ChangeRecord>,
  summaryByPath: Map<
    string,
    { readonly insertions: number; readonly deletions: number }
  >,
): void {
  for (const record of changes.values()) {
    if (record.status !== "R" || record.oldPath === undefined) continue;
    if (record.oldPath === record.path || changes.has(record.oldPath)) continue;
    const oldSummary = summaryByPath.get(record.oldPath);
    if (oldSummary === undefined) continue;
    const currentSummary = summaryByPath.get(record.path);
    summaryByPath.set(
      record.path,
      currentSummary === undefined
        ? oldSummary
        : {
            insertions: currentSummary.insertions + oldSummary.insertions,
            deletions: currentSummary.deletions + oldSummary.deletions,
          },
    );
    summaryByPath.delete(record.oldPath);
  }
}

function boundedLogicalLines(text: string): { lines: string[]; truncated: boolean } {
  if (text.length === 0) return { lines: [], truncated: false };
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    let end = index;
    if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
    lines.push(text.slice(start, end));
    start = index + 1;
    if (lines.length === MAX_PREVIEW_LINES) {
      return { lines, truncated: start < text.length };
    }
  }
  if (start < text.length) {
    if (lines.length === MAX_PREVIEW_LINES) return { lines, truncated: true };
    lines.push(text.slice(start));
  }
  return { lines, truncated: false };
}

export class GitRepository {
  private rootPath: string | undefined;

  constructor(private readonly runner: ProcessRunner = new BunProcessRunner()) {}

  static async open(
    cwd: string,
    runner: ProcessRunner = new BunProcessRunner(),
    signal: AbortSignal = new AbortController().signal,
  ): Promise<GitRepository | undefined> {
    throwIfAborted(signal);
    const args = ["rev-parse", "--show-toplevel"] as const;
    const output = await runner.run(cwd, "git", args, signal, SMALL_GIT_OUTPUT);
    if (output.truncated) throw new GitOutputError("git rev-parse output exceeded its output limit");
    if (output.exitCode !== 0) return undefined;
    const root = stripGitLineTerminator(
      decodeGitOutput(output.stdout, "git rev-parse output"),
    );
    if (root.length === 0) throw new GitOutputError("git rev-parse returned an empty repository root");
    const repository = new GitRepository(runner);
    repository.rootPath = nodePath.resolve(root);
    return repository;
  }

  private root(): string {
    if (this.rootPath === undefined) {
      throw new Error("GitRepository must be created with GitRepository.open()");
    }
    return this.rootPath;
  }

  private async run(
    args: readonly string[],
    signal: AbortSignal,
    maxBytes?: number,
  ): Promise<CommandOutput> {
    return this.runner.run(this.root(), "git", args, signal, maxBytes);
  }

  private async readStatus(signal: AbortSignal): Promise<Map<string, ChangeRecord>> {
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;
    const output = await this.run(args, signal);
    ensureComplete(args, output);
    return parsePorcelainV1Z(output.stdout);
  }

  private async detectHead(signal: AbortSignal): Promise<boolean> {
    const verifyArgs = ["rev-parse", "--verify", "HEAD"] as const;
    const verification = await this.run(verifyArgs, signal, SMALL_GIT_OUTPUT);
    if (verification.truncated) {
      throw new GitOutputError("git rev-parse HEAD output exceeded its output limit");
    }
    if (verification.exitCode === 0) return true;

    const symbolicArgs = ["symbolic-ref", "-q", "HEAD"] as const;
    const symbolic = await this.run(symbolicArgs, signal, SMALL_GIT_OUTPUT);
    if (symbolic.truncated) {
      throw new GitOutputError("git symbolic-ref HEAD output exceeded its output limit");
    }
    if (symbolic.exitCode === 0) return false;
    if (symbolic.exitCode === 1) throw commandFailure(verifyArgs, verification);
    throw commandFailure(symbolicArgs, symbolic);
  }

  private async addContentSummaries(
    changes: ReadonlyMap<string, ChangeRecord>,
    include: (record: ChangeRecord) => boolean,
    summaryByPath: Map<
      string,
      { readonly insertions: number; readonly deletions: number }
    >,
    signal: AbortSignal,
  ): Promise<void> {
    for (const record of changes.values()) {
      throwIfAborted(signal);
      if (!include(record) || record.status === "D") continue;
      try {
        const preview = await readProjectFilePreview(this.root(), record.path, signal);
        if (preview.kind === "text") {
          summaryByPath.set(record.path, {
            insertions: preview.lines.length,
            deletions: 0,
          });
        }
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
    }
  }

  async inspect(signal: AbortSignal): Promise<RepositoryInspection> {
    throwIfAborted(signal);
    const hasHead = await this.detectHead(signal);
    const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;
    const filesArgs = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"] as const;
    const numstatArgs = ["diff", "--no-ext-diff", "--no-color", "--numstat", "-z", "HEAD", "--", "."] as const;
    const [statusOutput, filesOutput, numstatOutput] = await Promise.all([
      this.run(statusArgs, signal),
      this.run(filesArgs, signal),
      hasHead ? this.run(numstatArgs, signal) : Promise.resolve(undefined),
    ]);
    ensureComplete(statusArgs, statusOutput);
    ensureComplete(filesArgs, filesOutput);
    if (numstatOutput !== undefined) ensureComplete(numstatArgs, numstatOutput);

    const changes = parsePorcelainV1Z(statusOutput.stdout);
    const summaryByPath = new Map<
      string,
      { readonly insertions: number; readonly deletions: number }
    >();
    for (const path of changes.keys()) {
      summaryByPath.set(path, { insertions: 0, deletions: 0 });
    }
    if (numstatOutput !== undefined) {
      const trackedSummaries = parseNumstatZ(numstatOutput.stdout);
      reconcileRenameSummaries(changes, trackedSummaries);
      for (const [path, summary] of trackedSummaries) {
        summaryByPath.set(path, summary);
      }
      await this.addContentSummaries(
        changes,
        (record) => record.status === "?",
        summaryByPath,
        signal,
      );
    } else {
      await this.addContentSummaries(changes, () => true, summaryByPath, signal);
    }

    let insertions = 0;
    let deletions = 0;
    for (const pathSummary of summaryByPath.values()) {
      insertions += pathSummary.insertions;
      deletions += pathSummary.deletions;
    }
    return {
      root: this.root(),
      hasHead,
      allFiles: parseNulPaths(filesOutput.stdout),
      changes,
      summaryByPath,
      summary: { files: changes.size, insertions, deletions },
    };
  }

  async contentHash(path: string, signal: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);
    let resolved: { displayPath: string; absolutePath: string };
    try {
      resolved = await resolveProjectFile(this.root(), path);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    throwIfAborted(signal);
    const file = await open(resolved.absolutePath, "r");
    const digest = createHash("sha256");
    const buffer = new Uint8Array(HASH_BUFFER_BYTES);
    try {
      while (true) {
        throwIfAborted(signal);
        const result = await file.read(buffer, 0, buffer.byteLength, null);
        if (result.bytesRead === 0) break;
        digest.update(buffer.subarray(0, result.bytesRead));
      }
      throwIfAborted(signal);
      return digest.digest("hex");
    } finally {
      await file.close();
    }
  }

  async preview(path: string, signal: AbortSignal): Promise<FilePreview> {
    throwIfAborted(signal);
    let displayPath = normalizeProjectPath(path);
    try {
      displayPath = validateProjectPath(this.root(), path);
      const [hasHead, changes] = await Promise.all([
        this.detectHead(signal),
        this.readStatus(signal),
      ]);
      const change = changes.get(displayPath);
      if (!hasHead || change === undefined || change.status === "?") {
        return await readProjectFilePreview(this.root(), displayPath, signal);
      }

      if (change.status !== "D") {
        try {
          const content = await readProjectFilePreview(this.root(), displayPath, signal);
          if (content.kind === "binary") return content;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }

      const args = [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        displayPath,
      ] as const;
      const output = await this.run(args, signal, MAX_PREVIEW_BYTES);
      if (output.exitCode !== 0) throw commandFailure(args, output);
      const content = boundedLogicalLines(new TextDecoder().decode(output.stdout));
      return {
        path: displayPath,
        kind: "diff",
        lines: content.lines,
        truncated: output.truncated || content.truncated,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        path: displayPath,
        kind: "error",
        lines: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
