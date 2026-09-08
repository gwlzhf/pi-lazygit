import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { clampTreeRatio, createPanelSettingsStore, DEFAULT_PANEL_SETTINGS } from "./settings";

const temporaryRoots: string[] = [];

async function settingsFile(): Promise<string> {
  const root = await mkdtemp(nodePath.join(tmpdir(), "pi-files-settings-"));
  temporaryRoots.push(root);
  return nodePath.join(root, "nested", "pi-lazygit.json");
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("clampTreeRatio", () => {
  test("keeps supported ratios and rejects values that are not finite numbers", () => {
    expect(clampTreeRatio(0.2)).toBe(0.2);
    expect(clampTreeRatio(0.9)).toBe(0.3);
    expect(clampTreeRatio(0)).toBe(0.05);
    expect(clampTreeRatio(Number.NaN)).toBeUndefined();
    expect(clampTreeRatio("0.2")).toBeUndefined();
    expect(clampTreeRatio(undefined)).toBeUndefined();
  });
});

describe("panel settings store", () => {
  test("round-trips a width through the settings file", async () => {
    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);

    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    store.saveTreeRatio(0.18);
    await store.flush();

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ treeRatio: 0.18 });
    expect(await createPanelSettingsStore(async () => file).load()).toEqual({ treeRatio: 0.18 });
  });

  test("coalesces a burst of width changes into the last value", async () => {
    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);

    for (const ratio of [0.1, 0.12, 0.14, 0.16]) store.saveTreeRatio(ratio);
    await store.flush();

    expect(await store.load()).toEqual({ treeRatio: 0.16 });
  });

  test("falls back to the defaults for unreadable, invalid, or out-of-range files", async () => {
    const missing = createPanelSettingsStore(async () => nodePath.join(tmpdir(), "pi-files-absent", "x.json"));
    expect(await missing.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);
    store.saveTreeRatio(0.2);
    await store.flush();

    await writeFile(file, "{ not json", "utf8");
    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    await writeFile(file, JSON.stringify({ treeRatio: "wide" }), "utf8");
    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    await writeFile(file, JSON.stringify({ treeRatio: 0.75 }), "utf8");
    expect(await store.load()).toEqual({ treeRatio: 0.3 });
  });

  test("ignores unwritable destinations and unsupported ratios", async () => {
    const failing = createPanelSettingsStore(async () => {
      throw new Error("no config directory");
    });
    failing.saveTreeRatio(0.2);
    await failing.flush();
    expect(await failing.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);
    store.saveTreeRatio(Number.NaN);
    await store.flush();
    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);
  });
});
