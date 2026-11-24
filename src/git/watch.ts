import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import type { WatchOptions } from "../contracts";

interface WatchTarget {
  readonly path: string;
  readonly metadata: boolean;
}

interface PromiseResolvers<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
}

function abortError(reason: unknown): DOMException {
  const error = new DOMException("The operation was aborted", "AbortError");
  if (reason !== undefined) Object.defineProperty(error, "cause", { value: reason });
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${description} is not valid UTF-8${detail}`);
  }
}

function stripLineTerminator(text: string): string {
  if (!text.endsWith("\n")) return text;
  const withoutLineFeed = text.slice(0, -1);
  return withoutLineFeed.endsWith("\r")
    ? withoutLineFeed.slice(0, -1)
    : withoutLineFeed;
}

async function resolveDirectory(path: string): Promise<string> {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error(`Expected Git metadata directory at ${path}`);
  }
  return resolved;
}

async function resolveGitDirectory(worktree: string): Promise<string> {
  const dotGit = nodePath.join(worktree, ".git");
  if ((await stat(dotGit)).isDirectory()) return resolveDirectory(dotGit);

  const declaration = stripLineTerminator(
    decodeUtf8(await readFile(dotGit), `${dotGit} file`),
  );
  const match = /^gitdir: (.+)$/.exec(declaration);
  if (match?.[1] === undefined) {
    throw new Error(`Malformed Git directory file at ${dotGit}`);
  }
  return resolveDirectory(nodePath.resolve(nodePath.dirname(dotGit), match[1]));
}

async function resolveCommonDirectory(gitDirectory: string): Promise<string> {
  let declaration: Uint8Array;
  try {
    declaration = await readFile(nodePath.join(gitDirectory, "commondir"));
  } catch (error) {
    if (isMissingFile(error)) return gitDirectory;
    throw error;
  }

  const commonDirectory = stripLineTerminator(
    decodeUtf8(declaration, `${gitDirectory}/commondir`),
  );
  if (commonDirectory.length === 0 || commonDirectory.includes("\n")) {
    throw new Error(`Malformed Git common directory file at ${gitDirectory}`);
  }
  return resolveDirectory(nodePath.resolve(gitDirectory, commonDirectory));
}

async function resolveWatchTargets(root: string, signal: AbortSignal): Promise<WatchTarget[]> {
  const worktree = await resolveDirectory(root);
  throwIfAborted(signal);
  const gitDirectory = await resolveGitDirectory(worktree);
  throwIfAborted(signal);
  const commonDirectory = await resolveCommonDirectory(gitDirectory);
  throwIfAborted(signal);

  const paths = new Set([worktree, gitDirectory, commonDirectory]);
  return [...paths].map(path => ({
    path,
    metadata: path !== worktree,
  }));
}

function isNoisyMetadataPath(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  return (
    normalized === "objects" ||
    normalized.startsWith("objects/") ||
    normalized === "logs" ||
    normalized.startsWith("logs/") ||
    normalized.endsWith(".lock")
  );
}

function shouldNotify(target: WatchTarget, filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const relativePath = String(filename).replaceAll("\\", "/");
  if (target.metadata) return !isNoisyMetadataPath(relativePath);
  // A recursive worktree watch also reports a bare `.git` whenever anything
  // below it changes, object writes included. The metadata watchers cover Git
  // state precisely, so the summary event would only reintroduce that noise.
  if (relativePath === ".git") return false;
  if (!relativePath.startsWith(".git/")) return true;
  return !isNoisyMetadataPath(relativePath.slice(".git/".length));
}

function watchTargets(targets: readonly WatchTarget[], options: WatchOptions): Promise<void> {
  const { promise, reject, resolve } = (
    Promise as typeof Promise & {
      withResolvers<T>(): PromiseResolvers<T>;
    }
  ).withResolvers<void>();
  const watchers: FSWatcher[] = [];
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    options.signal.removeEventListener("abort", onAbort);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // A watcher may already be closed after an underlying watch failure.
      }
    }
  };
  const fail = (error: unknown): void => {
    if (stopped) return;
    stop();
    reject(error);
  };
  const onAbort = (): void => {
    if (stopped) return;
    stop();
    resolve();
  };

  if (options.signal.aborted) {
    onAbort();
    return promise;
  }

  try {
    for (const target of targets) {
      const watcher = watch(
        target.path,
        { encoding: "utf8", recursive: true },
        (_event, filename) => {
          if (stopped || !shouldNotify(target, filename)) return;
          try {
            const relativePath = filename === null ? undefined : String(filename).replaceAll("\\", "/");
            // Metadata can change the meaning of every preview (HEAD, index,
            // attributes). Worktree edits only invalidate the affected file.
            options.onChange(target.metadata || relativePath?.startsWith(".git/")
              ? undefined
              : relativePath);
          } catch (error) {
            fail(error);
          }
        },
      );
      watchers.push(watcher);
      watcher.once("error", fail);
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  } catch (error) {
    fail(error);
  }
  return promise;
}

/** Watch a worktree and its Git metadata until `options.signal` is aborted. */
export async function watchGitRepository(root: string, options: WatchOptions): Promise<void> {
  try {
    throwIfAborted(options.signal);
    const targets = await resolveWatchTargets(root, options.signal);
    return await watchTargets(targets, options);
  } catch (error) {
    if (options.signal.aborted) throw abortError(options.signal.reason);
    options.onError(error);
    throw error;
  }
}
