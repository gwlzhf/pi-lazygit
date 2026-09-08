import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { ReviewSource } from "./contracts";
import { createExtension, FILES_SHORTCUT } from "./index";
import type { FilesPanel, FilesPanelOptions } from "./ui/files-panel";

type CommandRegistration = Parameters<ExtensionAPI["registerCommand"]>[1];
type ShortcutRegistration = Parameters<ExtensionAPI["registerShortcut"]>[1];
type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ApiHarness {
  readonly api: ExtensionAPI;
  readonly commands: Map<string, CommandRegistration>;
  readonly shortcuts: Map<string, ShortcutRegistration>;
  readonly lifecycle: Map<string, LifecycleHandler>;
}

interface ContextHarness {
  readonly ctx: ExtensionContext;
  readonly customCalls: Array<unknown>;
  readonly customOptions: Array<unknown>;
  readonly notifications: Array<readonly [string, string | undefined]>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createApiHarness(): ApiHarness {
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const lifecycle = new Map<string, LifecycleHandler>();

  const api = {
    registerCommand(name: string, options: CommandRegistration) {
      commands.set(name, options);
    },
    registerShortcut(shortcut: string, options: ShortcutRegistration) {
      shortcuts.set(shortcut, options);
    },
    on(event: string, handler: LifecycleHandler) {
      lifecycle.set(event, handler);
    },
    getSessionName() {
      return "review-session";
    },
  } as unknown as ExtensionAPI;

  return { api, commands, shortcuts, lifecycle };
}

function createContextHarness(options?: {
  readonly cwd?: string;
  readonly hasUI?: boolean;
  readonly mode?: ExtensionContext["mode"];
  readonly customResult?: Promise<undefined>;
}): ContextHarness {
  const customCalls: Array<unknown> = [];
  const customOptions: Array<unknown> = [];
  const notifications: Array<readonly [string, string | undefined]> = [];

  const ui = {
    notify(message: string, type?: string) {
      notifications.push([message, type]);
    },
    async custom(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => unknown,
      customOptionsArgument?: unknown,
    ) {
      customCalls.push(factory);
      customOptions.push(customOptionsArgument);
      factory({}, {}, {}, () => {});
      return options?.customResult ?? Promise.resolve(undefined);
    },
  };

  const ctx = {
    cwd: options?.cwd ?? "C:\\workspace",
    hasUI: options?.hasUI ?? true,
    mode: options?.mode ?? "tui",
    ui,
  } as unknown as ExtensionContext;

  return { ctx, customCalls, customOptions, notifications };
}

function createSource(): ReviewSource {
  return {
    refresh: async () => {
      throw new Error("not used by entry tests");
    },
    preview: async () => {
      throw new Error("not used by entry tests");
    },
  };
}

function createPanel(): FilesPanel {
  return {
    start() {},
    handleInput() {},
    render: () => [],
    invalidate() {},
    dispose() {},
  } as unknown as FilesPanel;
}

async function invokeCommand(
  command: CommandRegistration | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  expect(command).toBeDefined();
  await command?.handler("", ctx as never);
}

async function invokeShortcut(
  shortcut: ShortcutRegistration | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  expect(shortcut).toBeDefined();
  await shortcut?.handler(ctx);
}

test("registers /files, Alt+Q, and session lifecycle handlers", () => {
  const harness = createApiHarness();
  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel,
  })(harness.api);

  expect(harness.commands.get("files")?.description).toContain("files");
  expect(harness.shortcuts.get("alt+q")).toBeDefined();
  expect(harness.shortcuts.get("ctrl+shift+g")).toBeUndefined();
  expect(harness.lifecycle.get("session_start")).toBeDefined();
  expect(harness.lifecycle.get("session_shutdown")).toBeDefined();
});

test("registration performs no source, panel, or lifecycle work", () => {
  const harness = createApiHarness();
  const calls: string[] = [];

  createExtension({
    createReviewSource: () => {
      calls.push("source");
      return createSource();
    },
    prepareSession: async () => {
      calls.push("prepare");
    },
    clearSession: () => {
      calls.push("clear");
    },
    createPanel: () => {
      calls.push("panel");
      return createPanel();
    },
  })(harness.api);

  expect(calls).toEqual([]);
});

test("command and shortcut route through the same panel opener", async () => {
  const api = createApiHarness();
  const context = createContextHarness();
  const panelOptions: FilesPanelOptions[] = [];
  let sourceCreations = 0;
  let panelStarts = 0;
  const source = createSource();

  createExtension({
    createReviewSource: cwd => {
      sourceCreations += 1;
      expect(cwd).toBe("C:\\workspace");
      return source;
    },
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel: options => {
      panelOptions.push(options);
      const panel = createPanel();
      panel.start = () => {
        panelStarts += 1;
      };
      return panel;
    },
  })(api.api);

  await invokeCommand(api.commands.get("files"), context.ctx);
  await invokeShortcut(api.shortcuts.get(FILES_SHORTCUT), context.ctx);

  expect(sourceCreations).toBe(2);
  expect(context.customCalls).toHaveLength(2);
  expect(panelOptions).toHaveLength(2);
  expect(panelStarts).toBe(2);
  expect(panelOptions.map(options => options.cwd)).toEqual([
    "C:\\workspace",
    "C:\\workspace",
  ]);
  expect(panelOptions.map(options => options.source)).toEqual([source, source]);
  expect(panelOptions.map(options => options.sessionName)).toEqual([
    "review-session",
    "review-session",
  ]);
});

test("mounts the panel as a fullscreen overlay with mouse tracking", async () => {
  const api = createApiHarness();
  const context = createContextHarness();

  createExtension({
    createReviewSource: () => createSource(),
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel: () => createPanel(),
  })(api.api);

  await invokeCommand(api.commands.get("files"), context.ctx);

  expect(context.customOptions).toEqual([
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
        fullscreen: true,
        mouseTracking: true,
      },
    },
  ]);
});

test("does not mount a second panel while the first custom UI is open", async () => {
  const customResult = deferred<undefined>();
  const api = createApiHarness();
  const context = createContextHarness({ customResult: customResult.promise });
  let panelsCreated = 0;

  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel: () => {
      panelsCreated += 1;
      return createPanel();
    },
  })(api.api);

  const firstOpen = invokeCommand(api.commands.get("files"), context.ctx);
  const duplicateOpen = invokeShortcut(
    api.shortcuts.get(FILES_SHORTCUT),
    context.ctx,
  );
  await duplicateOpen;

  expect(context.customCalls).toHaveLength(1);
  expect(panelsCreated).toBe(1);

  customResult.resolve(undefined);
  await firstOpen;
});

test("warns and mounts nothing when interactive UI is unavailable", async () => {
  const api = createApiHarness();
  const context = createContextHarness({ hasUI: false, mode: "tui" });
  let sourcesCreated = 0;
  let panelsCreated = 0;

  createExtension({
    createReviewSource: cwd => {
      sourcesCreated += 1;
      return createSource();
    },
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel: () => {
      panelsCreated += 1;
      return createPanel();
    },
  })(api.api);

  await invokeCommand(api.commands.get("files"), context.ctx);

  expect(context.notifications).toHaveLength(1);
  expect(context.notifications[0]?.[1]).toBe("warning");
  expect(context.notifications[0]?.[0]).toContain("interactive");
  expect(context.customCalls).toHaveLength(0);
  expect(sourcesCreated).toBe(0);
  expect(panelsCreated).toBe(0);
});

test("does not mount outside TUI mode even if a host reports UI support", async () => {
  const api = createApiHarness();
  const context = createContextHarness({ hasUI: true, mode: "print" });
  let panelsCreated = 0;

  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel: () => {
      panelsCreated += 1;
      return createPanel();
    },
  })(api.api);

  await invokeShortcut(api.shortcuts.get(FILES_SHORTCUT), context.ctx);

  expect(context.notifications).toEqual([
    [expect.stringContaining("interactive"), "warning"],
  ]);
  expect(context.customCalls).toHaveLength(0);
  expect(panelsCreated).toBe(0);
});

test("prepares the session baseline before opening and clears it at shutdown", async () => {
  const baselinePrepared = deferred<undefined>();
  const api = createApiHarness();
  const context = createContextHarness({ cwd: "C:\\repo" });
  const calls: string[] = [];
  let sessionStartCompleted = false;

  createExtension({
    createReviewSource: cwd => {
      calls.push(`source:${cwd}`);
      return createSource();
    },
    prepareSession: async cwd => {
      calls.push(`prepare:${cwd}`);
      await baselinePrepared.promise;
      calls.push("prepared");
    },
    clearSession: () => {
      calls.push("clear");
    },
    createPanel,
  })(api.api);

  const sessionStart = Promise.resolve(
    api.lifecycle.get("session_start")?.(
      { type: "session_start" },
      context.ctx,
    ),
  ).then(() => {
    sessionStartCompleted = true;
  });

  await Promise.resolve();
  expect(calls).toEqual(["prepare:C:\\repo"]);
  expect(sessionStartCompleted).toBe(false);

  baselinePrepared.resolve(undefined);
  await sessionStart;
  await invokeCommand(api.commands.get("files"), context.ctx);
  await api.lifecycle.get("session_shutdown")?.(
    { type: "session_shutdown" },
    context.ctx,
  );

  expect(calls).toEqual([
    "prepare:C:\\repo",
    "prepared",
    "source:C:\\repo",
    "clear",
  ]);
});

test("reports baseline failures as warnings without rejecting session startup", async () => {
  const api = createApiHarness();
  const context = createContextHarness();

  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {
      throw new Error("Git is unavailable");
    },
    clearSession: () => {},
    createPanel,
  })(api.api);

  await expect(
    api.lifecycle.get("session_start")?.(
      { type: "session_start" },
      context.ctx,
    ),
  ).resolves.toBeUndefined();
  expect(context.notifications).toEqual([
    [expect.stringContaining("Git is unavailable"), "warning"],
  ]);
});

test("reports panel errors and releases the one-panel guard", async () => {
  const api = createApiHarness();
  const context = createContextHarness();
  let panelAttempts = 0;

  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel: () => {
      panelAttempts += 1;
      if (panelAttempts === 1) {
        throw new Error("panel failed");
      }
      return createPanel();
    },
  })(api.api);

  await invokeCommand(api.commands.get("files"), context.ctx);
  await invokeCommand(api.commands.get("files"), context.ctx);

  expect(panelAttempts).toBe(2);
  expect(context.notifications).toEqual([
    [expect.stringContaining("panel failed"), "error"],
  ]);
});

test("reports custom UI runtime failures as errors", async () => {
  const runtime = deferred<undefined>();
  const api = createApiHarness();
  const context = createContextHarness({ customResult: runtime.promise });

  createExtension({
    createReviewSource: createSource,
    prepareSession: async () => {},
    clearSession: () => {},
    createPanel,
  })(api.api);

  const open = invokeShortcut(api.shortcuts.get(FILES_SHORTCUT), context.ctx);
  runtime.reject(new Error("custom UI failed"));
  await open;

  expect(context.notifications).toEqual([
    [expect.stringContaining("custom UI failed"), "error"],
  ]);
});
