import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchGitRepository } from "../../src/git/watch";

/** `fs.watch` arms asynchronously, so mutations are repeated until one lands. */
const POLL_INTERVAL_MS = 100;
const CHANGE_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 20_000;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-watch-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A worktree skeleton: watching only needs `.git` to resolve, not real objects. */
async function worktree(): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(join(root, ".git", "objects"), { recursive: true });
  await mkdir(join(root, ".git", "logs"), { recursive: true });
  return root;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, milliseconds).unref?.();
  });
}

class ChangeObserver {
  readonly errors: unknown[] = [];
  #count = 0;

  readonly onChange = (): void => {
    this.#count += 1;
  };

  readonly onError = (error: unknown): void => {
    this.errors.push(error);
  };

  get count(): number {
    return this.#count;
  }

  /** Repeat `mutate` until a change is observed, or give up at the deadline. */
  async observes(mutate: () => Promise<void>): Promise<boolean> {
    const before = this.#count;
    const deadline = Date.now() + CHANGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await mutate();
      await delay(POLL_INTERVAL_MS);
      if (this.#count > before) return true;
    }
    return false;
  }

  /** Apply `mutate` repeatedly for a fixed window and expect silence. */
  async ignores(mutate: () => Promise<void>, windowMs = 600): Promise<boolean> {
    const before = this.#count;
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      await mutate();
      await delay(POLL_INTERVAL_MS);
    }
    return this.#count === before;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

test("reports worktree file writes and stops when the signal aborts", async () => {
  const root = await worktree();
  const controller = new AbortController();
  const observer = new ChangeObserver();
  const watching = watchGitRepository(root, {
    signal: controller.signal,
    onChange: observer.onChange,
    onError: observer.onError,
  });

  expect(
    await observer.observes(() => writeFile(join(root, "a.ts"), `export const a = ${Date.now()};\n`)),
  ).toBe(true);

  controller.abort();
  await watching;
  expect(observer.errors).toEqual([]);

  // A stopped watcher stays quiet.
  const afterAbort = observer.count;
  await writeFile(join(root, "b.ts"), "export const b = 1;\n");
  await delay(300);
  expect(observer.count).toBe(afterAbort);
}, TEST_TIMEOUT_MS);

test("reports Git metadata writes such as a moved HEAD", async () => {
  const root = await worktree();
  const controller = new AbortController();
  const observer = new ChangeObserver();
  const watching = watchGitRepository(root, {
    signal: controller.signal,
    onChange: observer.onChange,
    onError: observer.onError,
  });

  expect(
    await observer.observes(() => writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")),
  ).toBe(true);

  controller.abort();
  await watching;
}, TEST_TIMEOUT_MS);

test("ignores object, log, and lock churn while still seeing real edits", async () => {
  const root = await worktree();
  const controller = new AbortController();
  const observer = new ChangeObserver();
  const watching = watchGitRepository(root, {
    signal: controller.signal,
    onChange: observer.onChange,
    onError: observer.onError,
  });

  // Arm the watcher first, so the silence below is evidence of filtering
  // rather than evidence of a watcher that had not started yet.
  expect(
    await observer.observes(() => writeFile(join(root, "a.ts"), `export const a = ${Date.now()};\n`)),
  ).toBe(true);

  await mkdir(join(root, ".git", "objects", "ab"), { recursive: true });
  expect(
    await observer.ignores(async () => {
      await writeFile(join(root, ".git", "objects", "ab", "cdef"), `packed ${Date.now()}`);
      await writeFile(join(root, ".git", "logs", "HEAD"), `reflog ${Date.now()}\n`);
      await writeFile(join(root, ".git", "index.lock"), "");
    }),
  ).toBe(true);

  controller.abort();
  await watching;
  expect(observer.errors).toEqual([]);
}, TEST_TIMEOUT_MS);

test("follows a gitdir file to a separate Git directory", async () => {
  const root = await temporaryDirectory();
  const gitDirectory = join(await temporaryDirectory(), "worktrees", "linked");
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(join(root, ".git"), `gitdir: ${gitDirectory}\n`);

  const controller = new AbortController();
  const observer = new ChangeObserver();
  const watching = watchGitRepository(root, {
    signal: controller.signal,
    onChange: observer.onChange,
    onError: observer.onError,
  });

  expect(
    await observer.observes(() => writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/linked\n")),
  ).toBe(true);

  controller.abort();
  await watching;
}, TEST_TIMEOUT_MS);

test("also watches the common directory named by commondir", async () => {
  const root = await temporaryDirectory();
  const shared = await temporaryDirectory();
  const gitDirectory = join(shared, "worktrees", "linked");
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(join(root, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(gitDirectory, "commondir"), "../..\n");

  const controller = new AbortController();
  const observer = new ChangeObserver();
  const watching = watchGitRepository(root, {
    signal: controller.signal,
    onChange: observer.onChange,
    onError: observer.onError,
  });

  expect(
    await observer.observes(() =>
      writeFile(join(shared, "packed-refs"), `# pack-refs ${Date.now()}\n`),
    ),
  ).toBe(true);

  controller.abort();
  await watching;
}, TEST_TIMEOUT_MS);

test("rejects a malformed gitdir file and reports it once", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, ".git"), "not a gitdir declaration\n");
  const observer = new ChangeObserver();

  await expect(
    watchGitRepository(root, {
      signal: new AbortController().signal,
      onChange: observer.onChange,
      onError: observer.onError,
    }),
  ).rejects.toThrow(/Malformed Git directory file/);
  expect(observer.errors).toHaveLength(1);
});

test("reports a missing worktree without opening a watcher", async () => {
  const root = join(await temporaryDirectory(), "absent");
  const observer = new ChangeObserver();

  await expect(
    watchGitRepository(root, {
      signal: new AbortController().signal,
      onChange: observer.onChange,
      onError: observer.onError,
    }),
  ).rejects.toThrow();
  expect(observer.errors).toHaveLength(1);
});

test("aborting before the first watcher opens resolves without an error report", async () => {
  const root = await worktree();
  const controller = new AbortController();
  controller.abort();
  const observer = new ChangeObserver();

  await expect(
    watchGitRepository(root, {
      signal: controller.signal,
      onChange: observer.onChange,
      onError: observer.onError,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(observer.errors).toEqual([]);
});

test("surfaces a throwing onChange callback and tears the watchers down", async () => {
  const root = await worktree();
  const controller = new AbortController();
  const failure = new Error("render failed");
  const watching = watchGitRepository(root, {
    signal: controller.signal,
    onChange: () => {
      throw failure;
    },
    onError: () => {},
  });

  const deadline = Date.now() + CHANGE_TIMEOUT_MS;
  const settled = watching.then(() => "resolved", error => error);
  let outcome: unknown = undefined;
  while (Date.now() < deadline && outcome === undefined) {
    await writeFile(join(root, "a.ts"), `export const a = ${Date.now()};\n`);
    outcome = await Promise.race([settled, delay(POLL_INTERVAL_MS)]);
  }
  expect(outcome).toBe(failure);
}, TEST_TIMEOUT_MS);
