import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  DEFAULT_DIFF_CONTEXT,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINES,
  normalizeDiffContext,
  type AmendOptions,
  type AmendResult,
  type ChangeRecord,
  type ChangeSummary,
  type CommitDiffPreview,
  type CommitOptions,
  type CommitResult,
  type FilePreview,
  type GitBranch,
  type GitBranchSnapshot,
  type GitLogEntry,
  type GitLogSnapshot,
  type HeadMessage,
  normalizeProjectPath,
  type PushCandidate,
  type PushOptions,
  type PushPlan,
  type PushResult,
  type SwitchBranchOptions,
} from "../contracts";
import {
  isNotRegularFile,
  readProjectFilePreview,
  resolveProjectFile,
  validateProjectPath,
} from "../filesystem";
import {
  amendArgv,
  assertCommitMessage,
  commitArgv,
  planCommit,
  stageInvocations,
  type CommitPlan,
} from "./commit";
import {
  BunProcessRunner,
  type CommandOutput,
  type ProcessRunner,
  type RunOptions,
} from "./process";
import {
  type AheadBehind,
  DEFAULT_PUSH_TIMEOUT_MS,
  MAX_PUSH_PLAN_COMMITS,
  NON_INTERACTIVE_ENV,
  parseAheadBehind,
  parseUpstreamFields,
  pushArgv,
  type UpstreamRef,
} from "./push";
import { GitOutputError, parsePorcelainV1Z } from "./status";
const HISTORY_LIMIT = 200;

const SMALL_GIT_OUTPUT = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface RepositoryInspection {
  readonly root: string;
  readonly hasHead: boolean;
  readonly headIdentity: string;
  readonly currentBranch?: string;
  readonly detachedAt?: string;
  readonly allFiles: readonly string[];
  readonly changes: ReadonlyMap<string, ChangeRecord>;
  readonly summaryByPath: ReadonlyMap<
    string,
    { readonly insertions: number; readonly deletions: number }
  >;
  readonly summary: ChangeSummary;
}

interface HeadInspection {
  readonly hasHead: boolean;
  readonly headIdentity: string;
  readonly currentBranch?: string;
  readonly detachedAt?: string;
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

function redactCredentials(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    .replace(/\b(username|password) for ['"]https?:\/\/[^'"]+['"](?::[^\r\n]*)?/giu, "$1 for '[redacted]'")
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|TOKEN)|AUTHORIZATION)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]");
}

function commandFailure(args: readonly string[], output: CommandOutput): GitOutputError {
  const detail = redactCredentials(output.stderr.trim());
  const command = redactCredentials(args.join(" "));
  return new GitOutputError(
    `git ${command} failed with exit code ${output.exitCode}${detail ? `: ${detail}` : ""}`,
  );
}

function ensureComplete(args: readonly string[], output: CommandOutput): void {
  if (output.truncated) {
    throw new GitOutputError(
      `git ${redactCredentials(args.join(" "))} exceeded its output limit`,
    );
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
    // `--others` reports a nested repository as `dir/`; drop the separator so
    // the entry matches the status record and the tree node for the same path.
    const normalized = normalizeProjectPath(field);
    unique.add(
      normalized.length > 1 && normalized.endsWith("/")
        ? normalized.slice(0, -1)
        : normalized,
    );
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

function parseGitLog(bytes: Uint8Array): GitLogEntry[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new GitOutputError("Malformed git log output: missing final NUL terminator");
  }

  const fields = decodeGitOutput(bytes, "git log output").slice(0, -1).split("\0");
  if (fields.length % 5 !== 0) {
    throw new GitOutputError("Malformed git log output: incomplete record");
  }

  const entries: GitLogEntry[] = [];
  for (let index = 0; index < fields.length; index += 5) {
    const oid = fields[index];
    const shortOid = fields[index + 1];
    const subject = fields[index + 2];
    const author = fields[index + 3];
    const authoredAt = fields[index + 4];
    if (
      oid === undefined ||
      shortOid === undefined ||
      subject === undefined ||
      author === undefined ||
      authoredAt === undefined ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid) ||
      !/^[0-9a-f]+$/i.test(shortOid)
    ) {
      throw new GitOutputError(`Malformed git log output: invalid record ${index / 5 + 1}`);
    }
    const authoredAtValue = Number(authoredAt);
    if (!/^-?\d+$/.test(authoredAt) || !Number.isSafeInteger(authoredAtValue)) {
      throw new GitOutputError(
        `Malformed git log output: invalid authored timestamp in record ${index / 5 + 1}`,
      );
    }
    entries.push({ oid, shortOid, subject, author, authoredAt: authoredAtValue });
  }
  return entries;
}

function validateCommitOid(oid: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) {
    throw new GitOutputError("Invalid commit object ID");
  }
}

function parsePushCandidates(bytes: Uint8Array): PushCandidate[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new GitOutputError("Malformed git log output: missing final NUL terminator");
  }

  const fields = decodeGitOutput(bytes, "git log output").slice(0, -1).split("\0");
  if (fields.length % 3 !== 0) {
    throw new GitOutputError("Malformed git log output: incomplete record");
  }

  const candidates: PushCandidate[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const oid = fields[index];
    const shortOid = fields[index + 1];
    const subject = fields[index + 2];
    if (
      oid === undefined ||
      shortOid === undefined ||
      subject === undefined ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid) ||
      !/^[0-9a-f]+$/i.test(shortOid)
    ) {
      throw new GitOutputError(`Malformed git log output: invalid record ${index / 3 + 1}`);
    }
    candidates.push({ oid, shortOid, subject });
  }
  return candidates;
}

/**
 * Splits `git log -1 --format=%B` into the subject and the body, so a caller
 * replacing only the subject can replay the body verbatim.
 */
export function splitHeadMessage(message: string): { subject: string; body?: string } {
  const normalized = message.replace(/\r\n/gu, "\n");
  const separator = normalized.indexOf("\n");
  const subject = (separator < 0 ? normalized : normalized.slice(0, separator)).trim();
  const body = (separator < 0 ? "" : normalized.slice(separator + 1)).trim();
  return body.length > 0 ? { subject, body } : { subject };
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
    options?: RunOptions,
  ): Promise<CommandOutput> {
    return this.runner.run(this.root(), "git", args, signal, maxBytes, options);
  }

  private async readStatus(signal: AbortSignal): Promise<Map<string, ChangeRecord>> {
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;
    const output = await this.run(args, signal);
    ensureComplete(args, output);
    return parsePorcelainV1Z(output.stdout);
  }

  /** Full HEAD inspection used by {@link inspect}: verify first, then resolve symbolically. */
  private async detectHeadIdentity(signal: AbortSignal): Promise<HeadInspection> {
    const verifyArgs = ["rev-parse", "--verify", "HEAD"] as const;
    const verification = await this.run(verifyArgs, signal, SMALL_GIT_OUTPUT);
    if (verification.truncated) {
      throw new GitOutputError("git rev-parse HEAD output exceeded its output limit");
    }

    if (verification.exitCode !== 0) {
      const symbolicArgs = ["symbolic-ref", "-q", "HEAD"] as const;
      const symbolic = await this.run(symbolicArgs, signal, SMALL_GIT_OUTPUT);
      if (symbolic.truncated) {
        throw new GitOutputError("git symbolic-ref HEAD output exceeded its output limit");
      }
      if (symbolic.exitCode === 0) {
        const ref = stripGitLineTerminator(decodeGitOutput(symbolic.stdout, "git symbolic-ref output"));
        const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
        return { hasHead: false, headIdentity: `branch:${branch}`, currentBranch: branch };
      }
      if (symbolic.exitCode === 1) throw commandFailure(verifyArgs, verification);
      throw commandFailure(symbolicArgs, symbolic);
    }

    const oid = stripGitLineTerminator(decodeGitOutput(verification.stdout, "git rev-parse HEAD output"));
    const symbolicArgs = ["symbolic-ref", "-q", "HEAD"] as const;
    const symbolic = await this.run(symbolicArgs, signal, SMALL_GIT_OUTPUT);
    if (symbolic.truncated) {
      throw new GitOutputError("git symbolic-ref HEAD output exceeded its output limit");
    }
    if (symbolic.exitCode === 0) {
      const ref = stripGitLineTerminator(decodeGitOutput(symbolic.stdout, "git symbolic-ref output"));
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      if (branch.length > 0) {
        return { hasHead: true, headIdentity: `branch:${branch}`, currentBranch: branch };
      }
    }
    return { hasHead: true, headIdentity: `detached:${oid}`, detachedAt: oid.slice(0, 7) };
  }

  /** Lightweight current-branch lookup used by {@link branches} and {@link switchBranch}. */
  private async currentBranchInfo(
    signal: AbortSignal,
  ): Promise<{ readonly current?: string; readonly detachedAt?: string }> {
    const symbolicArgs = ["symbolic-ref", "-q", "HEAD"] as const;
    const symbolic = await this.run(symbolicArgs, signal, SMALL_GIT_OUTPUT);
    if (symbolic.truncated) {
      throw new GitOutputError("git symbolic-ref HEAD output exceeded its output limit");
    }
    if (symbolic.exitCode === 0) {
      const ref = stripGitLineTerminator(decodeGitOutput(symbolic.stdout, "git symbolic-ref output"));
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      if (branch.length > 0) return { current: branch };
    }

    const verifyArgs = ["rev-parse", "--verify", "HEAD"] as const;
    const verification = await this.run(verifyArgs, signal, SMALL_GIT_OUTPUT);
    if (verification.truncated) {
      throw new GitOutputError("git rev-parse HEAD output exceeded its output limit");
    }
    if (verification.exitCode !== 0) return {};
    const oid = stripGitLineTerminator(decodeGitOutput(verification.stdout, "git rev-parse HEAD output"));
    return { detachedAt: oid.slice(0, 7) };
  }

  async branches(signal: AbortSignal): Promise<GitBranchSnapshot> {
    throwIfAborted(signal);
    const listArgs = ["for-each-ref", "--format=%(refname:short)", "refs/heads"] as const;
    const [output, info] = await Promise.all([
      this.run(listArgs, signal, SMALL_GIT_OUTPUT),
      this.currentBranchInfo(signal),
    ]);
    ensureComplete(listArgs, output);
    const text = decodeGitOutput(output.stdout, "git for-each-ref output");
    const names = text
      .split(/\0|\n/u)
      .map(name => name.trim())
      .filter(name => name.length > 0);
    const sorted = [...new Set(names)].sort(compareCaseInsensitive);
    const branches: GitBranch[] = sorted.map(name => ({ name, current: name === info.current }));
    return {
      branches,
      ...(info.current !== undefined ? { current: info.current } : {}),
      ...(info.detachedAt !== undefined ? { detachedAt: info.detachedAt } : {}),
    };
  }

  async switchBranch(name: string, options: SwitchBranchOptions): Promise<void> {
    const signal = options.signal;
    throwIfAborted(signal);
    const snapshot = await this.branches(signal);
    if (!snapshot.branches.some(branch => branch.name === name)) {
      throw new GitOutputError(`Unknown local branch: ${JSON.stringify(name)}`);
    }
    const args = ["switch", "--no-guess", name] as const;
    const output = await this.run(args, signal, SMALL_GIT_OUTPUT);
    if (output.truncated) throw new GitOutputError(`git ${args.join(" ")} exceeded its output limit`);
    if (output.exitCode !== 0) throw commandFailure(args, output);
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
        // Submodules and untracked nested repositories appear in `git status`
        // as a single directory entry; they carry no line counts of their own.
        if (isMissingFile(error) || isNotRegularFile(error)) continue;
        throw error;
      }
    }
  }

  async inspect(signal: AbortSignal): Promise<RepositoryInspection> {
    throwIfAborted(signal);
    const head = await this.detectHeadIdentity(signal);
    const hasHead = head.hasHead;
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
    const inspection: RepositoryInspection = {
      root: this.root(),
      hasHead,
      headIdentity: head.headIdentity,
      ...(head.currentBranch !== undefined ? { currentBranch: head.currentBranch } : {}),
      ...(head.detachedAt !== undefined ? { detachedAt: head.detachedAt } : {}),
      allFiles: parseNulPaths(filesOutput.stdout),
      changes,
      summaryByPath,
      summary: { files: changes.size, insertions, deletions },
    };
    return inspection;
  }

  async history(signal: AbortSignal): Promise<GitLogSnapshot> {
    throwIfAborted(signal);
    const args = [
      "log",
      "-z",
      `--max-count=${HISTORY_LIMIT + 1}`,
      "--format=%H%x00%h%x00%s%x00%an%x00%at",
    ] as const;
    const output = await this.run(args, signal, MAX_PREVIEW_BYTES);
    ensureComplete(args, output);
    const entries = parseGitLog(output.stdout);
    return {
      entries: entries.slice(0, HISTORY_LIMIT),
      truncated: entries.length > HISTORY_LIMIT,
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
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(resolved.absolutePath, "r");
    } catch (error) {
      if (isMissingFile(error) || isNotRegularFile(error)) return null;
      throw error;
    }
    const digest = createHash("sha256");
    const buffer = new Uint8Array(HASH_BUFFER_BYTES);
    try {
      // A submodule or nested repository has no file content to fingerprint.
      if (!(await file.stat()).isFile()) return null;
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

  async preview(
    path: string,
    signal: AbortSignal,
    contextLines: number = DEFAULT_DIFF_CONTEXT,
  ): Promise<FilePreview> {
    throwIfAborted(signal);
    let displayPath = normalizeProjectPath(path);
    try {
      displayPath = validateProjectPath(this.root(), path);
      const [head, changes] = await Promise.all([
        this.detectHeadIdentity(signal),
        this.readStatus(signal),
      ]);
      const hasHead = head.hasHead;
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
        `--unified=${normalizeDiffContext(contextLines) ?? DEFAULT_DIFF_CONTEXT}`,
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

  async commitDiff(
    oid: string,
    signal: AbortSignal,
    contextLines: number = DEFAULT_DIFF_CONTEXT,
  ): Promise<CommitDiffPreview> {
    throwIfAborted(signal);
    try {
      validateCommitOid(oid);
      const args = [
        "show",
        "--format=",
        "--no-ext-diff",
        "--no-color",
        `--unified=${normalizeDiffContext(contextLines) ?? DEFAULT_DIFF_CONTEXT}`,
        oid,
        "--",
      ] as const;
      const output = await this.run(args, signal, MAX_PREVIEW_BYTES);
      if (output.exitCode !== 0) throw commandFailure(args, output);
      const content = boundedLogicalLines(decodeGitOutput(output.stdout, "git show output"));
      return {
        oid,
        kind: "diff",
        lines: content.lines,
        truncated: output.truncated || content.truncated,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        oid,
        kind: "error",
        lines: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Resolves a selection of project paths into the records Git reports for them. */
  private async selectedRecords(
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChangeRecord>> {
    const wanted = new Set<string>();
    for (const path of paths) {
      const normalized = normalizeProjectPath(path);
      const segments = normalized.split("/");
      if (
        normalized.length === 0 ||
        normalized.includes("\0") ||
        normalized.startsWith("/") ||
        nodePath.isAbsolute(normalized) ||
        nodePath.win32.isAbsolute(normalized) ||
        segments.some(segment => segment === "..")
      ) {
        throw new GitOutputError(`Refusing to commit an unsafe path: ${JSON.stringify(path)}`);
      }
      wanted.add(normalized);
    }
    if (wanted.size === 0) {
      throw new GitOutputError("Select at least one file to commit");
    }

    const changes = await this.readStatus(signal);
    const selected = new Map<string, ChangeRecord>();
    for (const path of wanted) {
      const record = changes.get(path);
      if (record !== undefined) selected.set(path, record);
    }
    return selected;
  }

  /** Records `plan` in the index, in batches that fit a Windows command line. */
  async stage(plan: CommitPlan, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (plan.paths.length === 0) {
      throw new GitOutputError("None of the selected files has changes Git can commit");
    }
    for (const invocation of stageInvocations(plan)) {
      throwIfAborted(signal);
      const output = await this.run(invocation.argv, signal, SMALL_GIT_OUTPUT);
      ensureComplete(invocation.argv, output);
    }
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    const signal = options.signal;
    throwIfAborted(signal);
    const message = assertCommitMessage(options.message);
    const selected = await this.selectedRecords(options.paths, signal);
    const plan = planCommit(selected);
    // Staging runs before the dry run so the report covers the selection rather
    // than whatever the index happened to hold. It only moves index entries, so
    // a cancelled confirmation leaves the files staged, never committed.
    await this.stage(plan, signal);

    const argv = commitArgv(message, plan.paths, {
      ...(options.dryRun === true ? { dryRun: true } : {}),
      ...(options.noVerify === true ? { noVerify: true } : {}),
    });
    const output = await this.run(argv, signal, MAX_PREVIEW_BYTES);
    if (output.truncated) {
      throw new GitOutputError(`git ${argv.join(" ")} exceeded its output limit`);
    }
    if (output.exitCode !== 0) throw commandFailure(argv, output);

    return {
      dryRun: options.dryRun === true,
      output: decodeGitOutput(output.stdout, "git commit output"),
      files: plan.paths.length,
    };
  }

  /** Whether the index still matches HEAD, so an amend cannot absorb staged work. */
  async indexMatchesHead(signal: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const args = ["diff", "--cached", "--quiet", "HEAD", "--"] as const;
    const output = await this.run(args, signal, SMALL_GIT_OUTPUT);
    if (output.truncated) throw new GitOutputError("git diff index output exceeded its output limit");
    if (output.exitCode === 0) return true;
    if (output.exitCode === 1) return false;
    throw commandFailure(args, output);
  }
  /** Returns the exact immutable inputs used to validate a persisted session baseline. */
  async cacheFingerprint(
    signal: AbortSignal,
  ): Promise<{ readonly headOid?: string; readonly indexFingerprint: string }> {
    throwIfAborted(signal);
    const head = await this.detectHeadIdentity(signal);
    const args = ["write-tree"] as const;
    const output = await this.run(args, signal, SMALL_GIT_OUTPUT);
    ensureComplete(args, output);
    const indexFingerprint = stripGitLineTerminator(
      decodeGitOutput(output.stdout, "git write-tree output"),
    );
    validateCommitOid(indexFingerprint);
    if (!head.hasHead) return { indexFingerprint };
    const headArgs = ["rev-parse", "--verify", "HEAD"] as const;
    const headOutput = await this.run(headArgs, signal, SMALL_GIT_OUTPUT);
    ensureComplete(headArgs, headOutput);
    const headOid = stripGitLineTerminator(decodeGitOutput(headOutput.stdout, "git rev-parse HEAD output"));
    validateCommitOid(headOid);
    return { headOid, indexFingerprint };
  }


  async upstream(signal: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal);
    const args = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"] as const;
    const output = await this.run(args, signal, SMALL_GIT_OUTPUT);
    if (output.truncated) {
      throw new GitOutputError("git rev-parse upstream output exceeded its output limit");
    }
    if (output.exitCode !== 0) {
      if (output.exitCode === 1 || /no upstream configured/iu.test(output.stderr)) {
        return undefined;
      }
      throw commandFailure(args, output);
    }
    const name = stripGitLineTerminator(
      decodeGitOutput(output.stdout, "git rev-parse upstream output"),
    ).trim();
    return name.length > 0 && name !== "@{u}" ? name : undefined;
  }

  /**
   * Asks Git which remote and tracking ref the branch follows. The `@{u}`
   * shorthand cannot be split by hand because either half may contain a slash.
   */
  private async upstreamRef(signal: AbortSignal): Promise<UpstreamRef | undefined> {
    throwIfAborted(signal);
    const branch = (await this.currentBranchInfo(signal)).current;
    if (branch === undefined) return undefined;
    const args = [
      "for-each-ref",
      "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${branch}`,
    ] as const;
    const output = await this.run(args, signal, SMALL_GIT_OUTPUT);
    if (output.truncated) {
      throw new GitOutputError("git for-each-ref output exceeded its output limit");
    }
    if (output.exitCode !== 0) return undefined;
    return parseUpstreamFields(
      decodeGitOutput(output.stdout, "git for-each-ref output"),
      branch,
    );
  }

  /** Whether HEAD already sits in its upstream's history, so amending rewrites it. */
  private async headIsPushed(signal: AbortSignal): Promise<boolean> {
    const upstream = await this.upstream(signal);
    if (upstream === undefined) return false;
    const args = ["merge-base", "--is-ancestor", "HEAD", upstream] as const;
    const output = await this.run(args, signal, SMALL_GIT_OUTPUT);
    if (output.truncated) throw new GitOutputError("git merge-base output exceeded its output limit");
    if (output.exitCode === 0) return true;
    if (output.exitCode === 1) return false;
    throw commandFailure(args, output);
  }

  async headMessage(signal: AbortSignal): Promise<HeadMessage | undefined> {
    throwIfAborted(signal);
    const head = await this.detectHeadIdentity(signal);
    if (!head.hasHead || head.detachedAt !== undefined) return undefined;

    const args = ["log", "-1", "--format=%B"] as const;
    const output = await this.run(args, signal, MAX_PREVIEW_BYTES);
    ensureComplete(args, output);
    const message = splitHeadMessage(
      decodeGitOutput(output.stdout, "git log output"),
    );
    return {
      ...message,
      pushed: await this.headIsPushed(signal),
    };
  }

  async amend(options: AmendOptions): Promise<AmendResult> {
    const signal = options.signal;
    throwIfAborted(signal);
    const subject = assertCommitMessage(options.subject);
    const head = await this.detectHeadIdentity(signal);
    if (!head.hasHead) {
      throw new GitOutputError("An unborn HEAD has no commit to amend");
    }
    if (head.detachedAt !== undefined) {
      throw new GitOutputError("A detached HEAD cannot be amended without orphaning its commit");
    }
    // `git commit --amend` rebuilds the commit from the index, so staged work
    // would be folded into the amended commit without being asked for.
    if (!(await this.indexMatchesHead(signal))) {
      throw new GitOutputError(
        "Staged changes would be folded into the amended commit; commit or reset them first",
      );
    }

    const messageArgs = ["log", "-1", "--format=%B"] as const;
    const messageOutput = await this.run(messageArgs, signal, MAX_PREVIEW_BYTES);
    ensureComplete(messageArgs, messageOutput);
    let originalMessage = stripGitLineTerminator(
      decodeGitOutput(messageOutput.stdout, "git log output"),
    );
    if (originalMessage.endsWith("\n")) originalMessage = originalMessage.slice(0, -1);
    const separator = originalMessage.indexOf("\n\n");
    const originalBody = separator < 0
      ? undefined
      : originalMessage.slice(separator + 2);
    const argv = amendArgv(subject, originalBody, {
      ...(options.noVerify === true ? { noVerify: true } : {}),
    });
    const output = await this.run(argv, signal, MAX_PREVIEW_BYTES);
    ensureComplete(argv, output);

    const verify = ["log", "-1", "--format=%H%x00%s%x00%b"] as const;
    const logged = await this.run(verify, signal, MAX_PREVIEW_BYTES);
    ensureComplete(verify, logged);
    const fields = decodeGitOutput(logged.stdout, "git log output").split("\0");
    const oid = fields[0] ?? "";
    validateCommitOid(oid);
    // A `commit-msg` hook may rewrite either half, so the stored message is
    // reported back instead of the one that was requested.
    return {
      oid,
      ...splitHeadMessage([fields[1] ?? "", fields[2] ?? ""].join("\n")),
    };
  }

  async pushPlan(options: { readonly signal: AbortSignal }): Promise<PushPlan> {
    const signal = options.signal;
    throwIfAborted(signal);
    const info = await this.currentBranchInfo(signal);
    const branch = info.current;
    if (branch === undefined) {
      throw new GitOutputError("A detached HEAD has no branch to push");
    }
    const upstream = await this.upstream(signal);
    if (upstream === undefined) {
      throw new GitOutputError(
        `Branch ${JSON.stringify(branch)} tracks no upstream; publish it with -u from a terminal first`,
      );
    }

    const countArgs = ["rev-list", "--left-right", "--count", `${upstream}...HEAD`] as const;
    const countOutput = await this.run(countArgs, signal, SMALL_GIT_OUTPUT);
    ensureComplete(countArgs, countOutput);
    let counts: AheadBehind;
    try {
      counts = parseAheadBehind(
        decodeGitOutput(countOutput.stdout, "git rev-list output"),
      );
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new GitOutputError(`Malformed git rev-list output${detail}`);
    }

    const logArgs = [
      "log",
      "-z",
      `--max-count=${MAX_PUSH_PLAN_COMMITS + 1}`,
      "--format=%H%x00%h%x00%s",
      `${upstream}..HEAD`,
    ] as const;
    const logOutput = await this.run(logArgs, signal, MAX_PREVIEW_BYTES);
    ensureComplete(logArgs, logOutput);
    const parsed = parsePushCandidates(logOutput.stdout);
    const commits = Object.freeze(parsed.slice(0, MAX_PUSH_PLAN_COMMITS));

    return {
      branch,
      upstream,
      ahead: counts.ahead,
      behind: counts.behind,
      commits,
      truncated: parsed.length > commits.length || counts.ahead > commits.length,
    };
  }

  private async nonInteractivePushEnv(
    remote: string,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, string>>> {
    const remoteArgs = ["remote", "get-url", "--push", "--all", remote] as const;
    const remoteOutput = await this.run(remoteArgs, signal, SMALL_GIT_OUTPUT);
    ensureComplete(remoteArgs, remoteOutput);
    const urls = decodeGitOutput(remoteOutput.stdout, "git remote URL output")
      .split(/\r?\n/u)
      .filter(url => url.length > 0);
    if (urls.length !== 1) {
      throw new GitOutputError("Refusing to push when a remote has multiple push URLs");
    }
    const url = urls[0] ?? "";
    const isWindowsDrivePath = /^[A-Za-z]:[\\/]/u.test(url);
    const isSshRemote =
      /^ssh:\/\//iu.test(url) ||
      (!isWindowsDrivePath && /^(?:[^/@:]+@)?[^/:]+:.+/u.test(url));
    if (!isSshRemote) {
      return NON_INTERACTIVE_ENV;
    }

    const configArgs = ["config", "--get", "core.sshCommand"] as const;
    const configured = await this.run(configArgs, signal, SMALL_GIT_OUTPUT);
    if (configured.truncated) {
      throw new GitOutputError("git config ssh command output exceeded its output limit");
    }
    const custom = process.env.GIT_SSH_COMMAND ??
      process.env.GIT_SSH ??
      (configured.exitCode === 0
        ? stripGitLineTerminator(decodeGitOutput(configured.stdout, "git ssh command output"))
        : undefined);
    if (custom !== undefined) {
      if (!/(?:BatchMode\s*=\s*yes|-batch)(?:\s|$)/iu.test(custom)) {
        throw new GitOutputError(
          "SSH push requires a non-interactive GIT_SSH_COMMAND/core.sshCommand (BatchMode=yes or -batch); custom SSH transports are not overridden",
        );
      }
      return NON_INTERACTIVE_ENV;
    }
    if (configured.exitCode !== 1) throw commandFailure(configArgs, configured);
    return { ...NON_INTERACTIVE_ENV, GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
  }

  async push(
    options: PushOptions,
    timeoutMs: number = DEFAULT_PUSH_TIMEOUT_MS,
  ): Promise<PushResult> {
    const signal = options.signal;
    throwIfAborted(signal);
    if (options.branch.trim().length === 0) {
      throw new GitOutputError("Refusing to push an empty branch name");
    }

    const head = await this.detectHeadIdentity(signal);
    if (!head.hasHead || head.detachedAt !== undefined) {
      throw new GitOutputError("A detached HEAD has no branch to push");
    }
    if (head.currentBranch !== options.branch) {
      throw new GitOutputError(
        `HEAD is on ${JSON.stringify(head.currentBranch ?? "")}, not ${JSON.stringify(options.branch)}`,
      );
    }

    const currentUpstream = await this.upstream(signal);
    if (currentUpstream === undefined) {
      throw new GitOutputError(
        `Branch ${JSON.stringify(options.branch)} tracks no upstream; publish it with -u from a terminal first`,
      );
    }
    if (currentUpstream !== options.upstream) {
      throw new GitOutputError("The branch upstream changed after the push was confirmed");
    }
    const ref = await this.upstreamRef(signal);
    if (ref === undefined) {
      throw new GitOutputError("The current branch has no resolved push destination");
    }
    if (!ref.trackingRef.startsWith("refs/heads/")) {
      throw new GitOutputError("Refusing to push to an upstream that is not a branch");
    }
    const refArgs = ["check-ref-format", ref.trackingRef] as const;
    const refOutput = await this.run(refArgs, signal, SMALL_GIT_OUTPUT);
    ensureComplete(refArgs, refOutput);

    const argv = pushArgv(ref.remote, options.branch, ref.trackingRef);
    const env = await this.nonInteractivePushEnv(ref.remote, signal);
    const output = await this.run(argv, signal, MAX_PREVIEW_BYTES, {
      env,
      timeoutMs,
    });
    if (output.truncated) {
      throw new GitOutputError(`git ${argv.join(" ")} exceeded its output limit`);
    }
    if (output.exitCode !== 0) throw commandFailure(argv, output);

    const stdout = redactCredentials(decodeGitOutput(output.stdout, "git push output"));
    const stderr = redactCredentials(output.stderr.trim());
    return {
      branch: options.branch,
      upstream: currentUpstream,
      output: [stdout, stderr].filter(part => part.length > 0).join("\n"),
    };
  }
}
