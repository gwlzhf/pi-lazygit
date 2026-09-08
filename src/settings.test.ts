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
  test("round-trips every panel preference through the settings file", async () => {
    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);

    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    store.saveTreeRatio(0.18);
    store.saveHighlightTheme("nord");
    store.saveTreeCollapsed(true);
    store.saveDiffLayout("split");
    store.saveDiffContext(25);
    await store.flush();

    const expected = {
      ...DEFAULT_PANEL_SETTINGS,
      treeRatio: 0.18,
      treeCollapsed: true,
      highlightTheme: "nord",
      diffLayout: "split",
      diffContext: 25,
    } as const;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expected);
    expect(await createPanelSettingsStore(async () => file).load()).toEqual(expected);
  });

  test("coalesces mixed changes into the last complete state", async () => {
    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);

    store.saveTreeRatio(0.1);
    store.saveHighlightTheme("nord");
    store.saveDiffLayout("split");
    store.saveTreeRatio(0.16);
    store.saveHighlightTheme("tokyo-night");
    store.saveDiffLayout("unified");
    await store.flush();

    expect(await store.load()).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      treeRatio: 0.16,
      highlightTheme: "tokyo-night",
      diffLayout: "unified",
    });
  });

  test("migrates old files and falls back invalid fields independently", async () => {
    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);
    store.saveTreeRatio(0.2);
    await store.flush();

    await writeFile(file, JSON.stringify({ treeRatio: 0.2 }), "utf8");
    expect(await store.load()).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      treeRatio: 0.2,
    });

    await writeFile(file, JSON.stringify({ treeRatio: 0.18, highlightTheme: "unknown" }), "utf8");
    expect(await store.load()).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      treeRatio: 0.18,
    });

    await writeFile(file, JSON.stringify({ treeRatio: "wide", highlightTheme: "nord" }), "utf8");
    expect(await store.load()).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      highlightTheme: "nord",
    });

    await writeFile(
      file,
      JSON.stringify({ treeCollapsed: "yes", diffLayout: "columns", diffContext: 7 }),
      "utf8",
    );
    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    await writeFile(
      file,
      JSON.stringify({ treeCollapsed: true, diffLayout: "split", diffContext: 10 }),
      "utf8",
    );
    expect(await store.load()).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      treeCollapsed: true,
      diffLayout: "split",
      diffContext: 10,
    });
  });

  test("falls back to defaults for unreadable files and clamps stored width", async () => {
    const missing = createPanelSettingsStore(async () => nodePath.join(tmpdir(), "pi-files-absent", "x.json"));
    expect(await missing.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    const file = await settingsFile();
    const store = createPanelSettingsStore(async () => file);
    store.saveTreeRatio(0.2);
    await store.flush();

    await writeFile(file, "{ not json", "utf8");
    expect(await store.load()).toEqual(DEFAULT_PANEL_SETTINGS);

    await writeFile(file, JSON.stringify({ treeRatio: 0.75 }), "utf8");
    expect(await store.load()).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      treeRatio: 0.3,
    });
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
