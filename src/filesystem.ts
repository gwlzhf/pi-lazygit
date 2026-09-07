import { open, readdir, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  MAX_FILESYSTEM_ENTRIES,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINES,
  type FilePreview,
  normalizeProjectPath,
} from "./contracts";

interface BoundedFile {
  readonly bytes: Uint8Array;
  readonly byteSize: number;
  readonly truncated: boolean;
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

function isWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relative))
  );
}

function lexicalProjectPath(root: string, projectPath: string): {
  displayPath: string;
  absolutePath: string;
} {
  const displayPath = normalizeProjectPath(projectPath);
  if (displayPath.length === 0 || displayPath.includes("\0")) {
    throw new Error("File path is empty or invalid");
  }
  const nativePath = displayPath.replaceAll("/", nodePath.sep);
  const absoluteRoot = nodePath.resolve(root);
  const absolutePath = nodePath.resolve(absoluteRoot, nativePath);
  if (!isWithin(absoluteRoot, absolutePath) || absolutePath === absoluteRoot) {
    throw new Error(`File path resolves outside project root: ${displayPath}`);
  }
  return { displayPath, absolutePath };
}

export async function resolveProjectFile(
  root: string,
  projectPath: string,
): Promise<{ displayPath: string; absolutePath: string }> {
  const lexical = lexicalProjectPath(root, projectPath);
  const [physicalRoot, physicalPath] = await Promise.all([
    realpath(root),
    realpath(lexical.absolutePath),
  ]);
  if (!isWithin(physicalRoot, physicalPath) || physicalPath === physicalRoot) {
    throw new Error(`File path resolves outside project root: ${lexical.displayPath}`);
  }
  return { displayPath: lexical.displayPath, absolutePath: physicalPath };
}

export function validateProjectPath(root: string, projectPath: string): string {
  return lexicalProjectPath(root, projectPath).displayPath;
}

async function readBoundedFile(
  absolutePath: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<BoundedFile> {
  throwIfAborted(signal);
  const file = await open(absolutePath, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Selected path is not a regular file");
    const targetLength = Math.min(stats.size, maxBytes);
    const buffer = new Uint8Array(targetLength);
    let offset = 0;
    while (offset < targetLength) {
      throwIfAborted(signal);
      const result = await file.read(buffer, offset, targetLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    throwIfAborted(signal);
    return {
      bytes: offset === buffer.byteLength ? buffer : buffer.slice(0, offset),
      byteSize: stats.size,
      truncated: stats.size > maxBytes,
    };
  } finally {
    await file.close();
  }
}

function logicalLines(
  text: string,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  if (text.length === 0) return { lines: [], truncated: false };
  const lines: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    let end = index;
    if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
    lines.push(text.slice(start, end));
    start = index + 1;
    if (lines.length === maxLines) {
      return { lines, truncated: start < text.length };
    }
  }

  if (start < text.length) {
    if (lines.length === maxLines) return { lines, truncated: true };
    lines.push(text.slice(start));
  }
  return { lines, truncated: false };
}

export async function readProjectFilePreview(
  root: string,
  projectPath: string,
  signal: AbortSignal,
  maxBytes = MAX_PREVIEW_BYTES,
  maxLines = MAX_PREVIEW_LINES,
): Promise<FilePreview> {
  const resolved = await resolveProjectFile(root, projectPath);
  const file = await readBoundedFile(resolved.absolutePath, signal, maxBytes);
  if (file.bytes.includes(0)) {
    return {
      path: resolved.displayPath,
      kind: "binary",
      lines: ["Binary file"],
      byteSize: file.byteSize,
      truncated: file.truncated,
    };
  }

  const content = logicalLines(new TextDecoder().decode(file.bytes), maxLines);
  return {
    path: resolved.displayPath,
    kind: "text",
    lines: content.lines,
    byteSize: file.byteSize,
    truncated: file.truncated || content.truncated,
  };
}

function errorPreview(projectPath: string, error: unknown): FilePreview {
  const message = error instanceof Error ? error.message : String(error);
  return {
    path: normalizeProjectPath(projectPath),
    kind: "error",
    lines: [],
    truncated: false,
    error: message,
  };
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

export class FilesystemProject {
  constructor(
    readonly root: string,
    private readonly entryLimit = MAX_FILESYSTEM_ENTRIES,
  ) {
    if (!Number.isSafeInteger(entryLimit) || entryLimit < 0) {
      throw new RangeError("entryLimit must be a non-negative safe integer");
    }
  }

  async inspect(
    signal: AbortSignal,
  ): Promise<{ allFiles: readonly string[]; truncated: boolean }> {
    throwIfAborted(signal);
    const directories = [""];
    const allFiles: string[] = [];
    let directoryIndex = 0;
    let entriesSeen = 0;

    while (directoryIndex < directories.length) {
      throwIfAborted(signal);
      const relativeDirectory = directories[directoryIndex];
      if (relativeDirectory === undefined) break;
      directoryIndex += 1;
      const absoluteDirectory = relativeDirectory
        ? nodePath.join(this.root, ...relativeDirectory.split("/"))
        : this.root;
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      entries.sort((left, right) => compareCaseInsensitive(left.name, right.name));

      for (const entry of entries) {
        throwIfAborted(signal);
        if (entry.name === ".git") continue;
        if (entriesSeen === this.entryLimit) {
          return { allFiles, truncated: true };
        }
        entriesSeen += 1;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (entry.isDirectory()) {
          directories.push(relativePath);
        } else if (entry.isFile()) {
          allFiles.push(normalizeProjectPath(relativePath));
        }
      }
    }

    return { allFiles, truncated: false };
  }

  async preview(path: string, signal: AbortSignal): Promise<FilePreview> {
    throwIfAborted(signal);
    try {
      return await readProjectFilePreview(this.root, path, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return errorPreview(path, error);
    }
  }
}
