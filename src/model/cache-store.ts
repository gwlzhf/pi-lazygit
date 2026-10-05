import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isSerializedBaseline } from "./baseline";
import type { SerializedBaseline } from "./baseline";

/** The repository and Git state that makes one baseline snapshot reusable. */
export interface BaselineCacheIdentity {
  readonly canonicalRoot: string;
  readonly headIdentity: string;
  readonly headOid: string;
  readonly indexFingerprint: string;
}

/** Persistent storage for serialized session baselines. */
export interface BaselineCacheStore {
  load(identity: BaselineCacheIdentity): Promise<SerializedBaseline | undefined>;
  save(identity: BaselineCacheIdentity, baseline: SerializedBaseline): Promise<void>;
  remove(identity: BaselineCacheIdentity): Promise<void>;
  clearForRoot(root: string): Promise<void>;
}

export interface BaselineCacheStoreOptions {
  readonly resolveAgentDir?: () => Promise<string>;
}

interface CacheEnvelope {
  readonly version: 1;
  readonly identity: BaselineCacheIdentity;
  readonly baseline: SerializedBaseline;
}

const CACHE_DIRECTORY = "pi-lazygit-cache/v1";

function canonicalRoot(root: string): string {
  const absoluteRoot = resolve(root);
  return process.platform === "win32" ? absoluteRoot.toLowerCase() : absoluteRoot;
}

function fileName(root: string): string {
  const digest = createHash("sha256").update(canonicalRoot(root)).digest("hex");
  return `${digest.slice(0, 16)}.json`;
}

async function defaultAgentDir(): Promise<string> {
  // Keep the plugin entry point out of this model's import graph until storage is used.
  const { getAgentDir } = await import("@oh-my-pi/pi-coding-agent");
  return getAgentDir();
}

function isIdentity(value: unknown): value is BaselineCacheIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.canonicalRoot === "string" &&
    typeof identity.headIdentity === "string" && identity.headIdentity.length > 0 &&
    typeof identity.headOid === "string" && identity.headOid.length > 0 &&
    typeof identity.indexFingerprint === "string" && identity.indexFingerprint.length > 0;
}

function sameIdentity(left: BaselineCacheIdentity, right: BaselineCacheIdentity): boolean {
  return canonicalRoot(left.canonicalRoot) === canonicalRoot(right.canonicalRoot) &&
    left.headIdentity === right.headIdentity && left.headOid === right.headOid &&
    left.indexFingerprint === right.indexFingerprint;
}

function isEnvelope(value: unknown): value is CacheEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1 || !isIdentity(envelope.identity) ||
    !isSerializedBaseline(envelope.baseline)) return false;
  return canonicalRoot(envelope.baseline.root) ===
      canonicalRoot(envelope.identity.canonicalRoot) &&
    envelope.baseline.headIdentity === envelope.identity.headIdentity;
}


/** Create a best-effort, versioned cache for repository session baselines. */
export function createBaselineCacheStore(
  options: BaselineCacheStoreOptions = {},
): BaselineCacheStore {
  const resolveAgentDir = options.resolveAgentDir ?? defaultAgentDir;
  const pathFor = async (root: string): Promise<string> =>
    join(await resolveAgentDir(), CACHE_DIRECTORY, fileName(root));

  const removeFile = async (file: string): Promise<void> => {
    try {
      await unlink(file);
    } catch {
    }
  };

  const removeIfUnchanged = async (file: string, expected: string): Promise<void> => {
    try {
      if (await readFile(file, "utf8") === expected) await unlink(file);
    } catch {
    }
  };

  return {
    async load(identity) {
      let file: string;
      let raw: string;
      try {
        file = await pathFor(identity.canonicalRoot);
        raw = await readFile(file, "utf8");
      } catch {
        return undefined;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        await removeIfUnchanged(file, raw);
        return undefined;
      }
      if (!isEnvelope(value)) {
        await removeIfUnchanged(file, raw);
        return undefined;
      }
      if (!sameIdentity(value.identity, identity)) return undefined;
      return value.baseline;
    },
    async save(identity, baseline) {
      let temporary: string | undefined;
      try {
        if (!isIdentity(identity) || !isSerializedBaseline(baseline) ||
          canonicalRoot(baseline.root) !== canonicalRoot(identity.canonicalRoot) ||
          baseline.headIdentity !== identity.headIdentity) return;
        const file = await pathFor(identity.canonicalRoot);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
        const envelope: CacheEnvelope = { version: 1, identity, baseline };
        await writeFile(temporary, `${JSON.stringify(envelope)}\n`, "utf8");
        await rename(temporary, file);
        temporary = undefined;
      } catch {
      } finally {
        if (temporary !== undefined) await removeFile(temporary);
      }
    },
    async remove(identity) {
      try {
        await removeFile(await pathFor(identity.canonicalRoot));
      } catch {
      }
    },
    async clearForRoot(root) {
      try {
        await removeFile(await pathFor(root));
      } catch {
      }
    },
  };
}
