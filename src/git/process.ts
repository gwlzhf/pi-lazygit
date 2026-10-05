const DEFAULT_STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export interface CommandOutput {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

/** Per-invocation settings a network or hook-backed command needs. */
export interface RunOptions {
  /** Merged over the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kills the child after this many milliseconds; the caller signal still wins. */
  readonly timeoutMs?: number;
}

export interface ProcessRunner {
  run(
    cwd: string,
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    maxBytes?: number,
    options?: RunOptions,
  ): Promise<CommandOutput>;
}

function abortError(reason: unknown): DOMException {
  const error = new DOMException("The operation was aborted", "AbortError");
  if (reason !== undefined) Object.defineProperty(error, "cause", { value: reason });
  return error;
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      const remaining = limit - retained;
      if (remaining > 0) {
        const length = Math.min(remaining, chunk.byteLength);
        chunks.push(length === chunk.byteLength ? chunk : chunk.slice(0, length));
        retained += length;
      }
      if (chunk.byteLength > remaining) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export class BunProcessRunner implements ProcessRunner {
  async run(
    cwd: string,
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    maxBytes = DEFAULT_STDOUT_LIMIT,
    options?: RunOptions,
  ): Promise<CommandOutput> {
    validateLimit(maxBytes);
    if (options?.timeoutMs !== undefined) validateTimeout(options.timeoutMs);
    if (signal.aborted) throw abortError(signal.reason);

    const child = Bun.spawn([executable, ...args], {
      cwd,
      // A child that waits on stdin would hang the panel: nothing is wired to
      // answer it, and the TUI has no terminal to hand over.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    });
    let aborted = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (options?.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, options.timeoutMs);
      timer.unref?.();
    }

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(child.stdout, maxBytes),
        readCapped(child.stderr, STDERR_LIMIT),
        child.exited,
      ]);
      if (timedOut) {
        throw new Error(
          `${executable} timed out after ${String(options?.timeoutMs)}ms`,
        );
      }
      if (aborted) throw abortError(signal.reason);
      return {
        stdout: stdout.bytes,
        stderr: new TextDecoder().decode(stderr.bytes),
        exitCode,
        truncated: stdout.truncated,
      };
    } catch (error) {
      if (timedOut && !(error instanceof Error && error.name === "AbortError")) {
        throw new Error(
          `${executable} timed out after ${String(options?.timeoutMs)}ms`,
        );
      }
      if (aborted && !timedOut) throw abortError(signal.reason);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
