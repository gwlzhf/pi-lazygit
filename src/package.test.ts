import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

interface PackageManifest {
  readonly version?: string;
  readonly files?: readonly string[];
  readonly exports?: Record<string, unknown>;
  readonly omp?: { readonly extensions?: readonly string[] };
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

const sourceDirectory = resolve(import.meta.dir);
const repositoryDirectory = dirname(sourceDirectory);
const manifestPath = join(repositoryDirectory, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
const shippedFiles = new Set(manifest.files ?? []);

const expectedRuntimeFiles = [
  "src/contracts.ts",
  "src/filesystem.ts",
  "src/index.ts",
  "src/settings.ts",
  "src/pi-settings.ts",
  "src/highlight-theme.ts",
  "src/review-source.ts",
  "src/git/process.ts",
  "src/git/repository.ts",
  "src/git/status.ts",
  "src/git/watch.ts",
  "src/model/baseline.ts",
  "src/model/tree.ts",
  "src/ui/diff-view.ts",
  "src/ui/files-panel.ts",
  "src/ui/highlight.ts",
  "src/ui/render.ts",
  "src/ui/selection.ts",
  "src/ui/review-controller.ts",
  "src/ui/presentation.ts",
  "src/opencode/index.tsx",
  "src/opencode/files-route.tsx",
  "src/opencode/selection.ts",
  "src/opencode/settings.ts",
] as const;

const expectedPeers = {
  "@oh-my-pi/pi-coding-agent": ">=18.0.11 <19",
  "@oh-my-pi/pi-tui": ">=18.0.11 <19",
  "@opencode-ai/plugin": ">=1.18.31 <2",
  "@opentui/core": ">=0.5.11 <1",
  "@opentui/solid": ">=0.5.11 <1",
  "@opentui/keymap": ">=0.5.11 <1",
  "solid-js": ">=1.9.12 <2",
} as const;

async function runtimeSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await runtimeSourceFiles(path));
    } else if ((extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /\b(?:from\s+|import\s*(?:\(\s*)?)[\"']([^\"']+)[\"']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  return specs;
}

function importPath(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find(candidate => expectedRuntimeFiles.includes(relative(repositoryDirectory, candidate).replaceAll("\\", "/") as (typeof expectedRuntimeFiles)[number]));
}

async function collectImportGraph(entrypoint: string): Promise<{ paths: Set<string>; source: string }> {
  const paths = new Set<string>();
  const sources: string[] = [];
  const visit = async (path: string): Promise<void> => {
    if (paths.has(path)) return;
    paths.add(path);
    const source = await readFile(path, "utf8");
    sources.push(source);
    for (const specifier of importSpecifiers(source)) {
      const imported = importPath(path, specifier);
      if (imported !== undefined) await visit(imported);
    }
  };
  await visit(join(repositoryDirectory, entrypoint.replace(/^\.\//, "")));
  return { paths, source: sources.join("\n") };
}

test("manifest exposes both host entrypoints and the exact package contract", async () => {
  expect(manifest.version).toBe("0.5.1");
  expect(manifest.omp?.extensions).toEqual(["./src/index.ts"]);
  expect(manifest.exports).toEqual({
    "./tui": {
      types: "./src/opencode/index.tsx",
      import: "./src/opencode/index.tsx",
    },
  });
  expect(manifest.exports).not.toHaveProperty(".");
  expect(manifest).not.toHaveProperty("main");
  expect(manifest).not.toHaveProperty("server");
  expect(shippedFiles.has("src/index.ts")).toBe(true);
  expect(shippedFiles.has("src/opencode/index.tsx")).toBe(true);
  expect(await Bun.file(join(repositoryDirectory, "src/index.ts")).exists()).toBe(true);
  expect(await Bun.file(join(repositoryDirectory, "src/opencode/index.tsx")).exists()).toBe(true);
});

test("all runtime source files are shipped and tests are excluded", async () => {
  const actualRuntimeFiles = (await runtimeSourceFiles(sourceDirectory))
    .map(path => relative(repositoryDirectory, path).replaceAll("\\", "/"))
    .sort();
  expect(actualRuntimeFiles).toEqual([...expectedRuntimeFiles].sort());
  for (const file of expectedRuntimeFiles) expect(shippedFiles.has(file)).toBe(true);
  expect([...shippedFiles].some(file => /\.test\.(?:ts|tsx)$/.test(file))).toBe(false);
  expect([...shippedFiles].some(file => file === "test/smoke-fixture.ts" || file.startsWith("test/"))).toBe(false);
});

test("every relative runtime import resolves to an allowlisted file", async () => {
  const sourceFiles = await runtimeSourceFiles(sourceDirectory);
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const imported = importPath(path, specifier);
      expect(imported, `${relative(repositoryDirectory, path)} imports ${specifier}`).toBeDefined();
      expect(imported === undefined ? undefined : shippedFiles.has(relative(repositoryDirectory, imported).replaceAll("\\", "/"))).toBe(true);
    }
  }
});

test("Pi and OpenCode host dependencies are optional peers with exact compatibility ranges", () => {
  expect(manifest.peerDependencies).toEqual(expectedPeers);
  for (const name of Object.keys(expectedPeers)) {
    expect(manifest.peerDependenciesMeta?.[name]).toEqual({ optional: true });
  }
});

test("OpenCode runtime graph is isolated from Pi packages and Pi highlighter", async () => {
  const graph = await collectImportGraph("src/opencode/index.tsx");
  expect(graph.source).not.toMatch(/@oh-my-pi\/(?:pi-coding-agent|pi-tui)/);
  expect([...graph.paths].some(path => path.endsWith("src/ui/highlight.ts"))).toBe(false);
  expect([...graph.paths].some(path => path.endsWith("src/ui/files-panel.ts"))).toBe(false);
});
