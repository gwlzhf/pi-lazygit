const DEFAULT_STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export interface CommandOutput {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

export interface ProcessRunner {
  run(
    cwd: string,
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    maxBytes?: number,
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
  ): Promise<CommandOutput> {
    validateLimit(maxBytes);
    if (signal.aborted) throw abortError(signal.reason);

    const child = Bun.spawn([executable, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(child.stdout, maxBytes),
        readCapped(child.stderr, STDERR_LIMIT),
        child.exited,
      ]);
      if (aborted) throw abortError(signal.reason);
      return {
        stdout: stdout.bytes,
        stderr: new TextDecoder().decode(stderr.bytes),
        exitCode,
        truncated: stdout.truncated,
      };
    } catch (error) {
      if (aborted) throw abortError(signal.reason);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
