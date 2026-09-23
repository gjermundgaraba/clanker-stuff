import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { collectContributions, ContributedTools } from "@clanker-stuff/code-mode-tools";
import type { ToolInventory, ToolAccounting } from "@clanker-stuff/code-mode-tools";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";
import backgroundTasks from "../../background-tasks/index.js";
import { TaskRuntime } from "../../background-tasks/runtime.js";
import { registerTaskTools } from "../../background-tasks/register.js";
import mcp from "../../../mcp/index.js";
import { fixtureServer, setupMcpTest } from "../../../mcp/tests/helpers.js";
import { toGeneratedToolName } from "../../../mcp/bridge.js";
import type { SamplingScopeRequest } from "../../../mcp/sampling-protocol.js";
import { CodeModeRuntime, toNestedTool } from "../code-mode/tools.js";
import { registerFallbackCodexTools } from "./tool-fixtures.js";
import { createToolsModel } from "./fixtures.js";

describe("Code Mode contributions", () => {
  const t = setupMcpTest();

  it("consumes a retrieved task notice even when the Code Mode caller discards the result", async () => {
    let runtime!: TaskRuntime;
    let sources = (): ToolInventory[] => [];

    const host = t.createExtensionHost((pi) => {
      runtime = new TaskRuntime(pi);
      registerTaskTools(pi, runtime);
      sources = () => collectContributions(pi);
    });

    await host.emitSessionStart();
    const ctx = host.createContext({ mode: "tui", isIdle: () => false });
    runtime.startSession(ctx);

    try {
      const task = await runtime.supervisor.start({
        name: "nested-retrieval",
        command: process.execPath,
        args: ["-e", ""],
        cwd: ctx.cwd,
        origin: "test-origin",
      });

      await expect.poll(() => task.outcome).toBe("completed");
      await task.cleanupPromise;
      expect(runtime.inbox.count).toBe(1);

      const tool = sources()
        .flatMap((source) => source.tools)
        .find(({ definition }) => definition.name === "task_inspect");

      if (!tool) throw new Error("Missing task contribution");
      // Invoke the real nested adapter but never emit its return value as cell output.
      await toNestedTool(tool).invoke(
        { id: task.id, view: "summary" },
        { cellId: "discarded-result", extensionContext: ctx },
        new AbortController().signal,
      );
      expect(runtime.inbox.count).toBe(0);
      expect(runtime.inbox.lookup(task.id)).toMatchObject([
        { terminal: true, reason: "completed" },
      ]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects invalid publications before changing registrations or placement", async () => {
    let source: ContributedTools | undefined;
    const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode_only" };

    const host = t.createExtensionHost(
      (pi) => {
        registerFallbackCodexTools(pi);
        source = new ContributedTools(pi);
      },
      { model },
    );

    await host.emitSessionStart();

    if (!source) throw new Error("Missing source");

    const definition = (name: string) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    });

    source.registerTool(definition("kept"));
    source.setEnabled();
    const active = host.getActiveTools();
    const description = host.getRegisteredTools().get("exec")?.definition.description;
    source.registerTool(definition("a-b"));
    source.registerTool(definition("a_b"));
    const publish = source;
    expect(() => publish.setEnabled()).toThrow("Duplicate");
    expect(host.getActiveTools()).toEqual(active);
    expect(host.getRegisteredTools().has("a-b")).toBe(false);
    expect(host.getRegisteredTools().has("a_b")).toBe(false);
    expect(host.getRegisteredTools().get("exec")?.definition.description).toBe(description);
    expect(source.snapshot().tools.map(({ definition }) => definition.name)).toEqual(["kept"]);
    expect(
      host
        .getNotifications()
        .some(({ type, message }) => type === "error" && message.includes("inventory rejected")),
    ).toBe(true);
    source.setEnabled();
    expect(source.snapshot().ownedNames).toEqual(["kept"]);
  });

  it("preserves owner enablement while changing direct and nested placement", async () => {
    let disable = () => {};

    const initial = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode_only" };

    const host = t.createExtensionHost(
      (pi) => {
        registerFallbackCodexTools(pi);
        const source = new ContributedTools(pi);

        for (const name of ["enabled", "disabled"])
          source.registerTool({
            name,
            label: name,
            description: name,
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: undefined }),
          });
        pi.on("session_start", () => source.setEnabled(["enabled"]));
        disable = () => source.setEnabled([]);
      },
      { model: initial },
    );

    await host.emitSessionStart();

    for (const mode of ["direct", "code_mode", "code_mode_only"]) {
      const model = { ...initial, codexToolMode: mode };
      await host.emit(
        "model_select",
        { type: "model_select", model, previousModel: initial, source: "set" },
        host.createContext({ model }),
      );
      expect(host.getActiveTools().includes("enabled")).toBe(mode !== "code_mode_only");
      expect(host.getActiveTools()).not.toContain("disabled");
    }

    disable();
    const model = { ...initial, codexToolMode: "direct" };
    await host.emit(
      "model_select",
      { type: "model_select", model, previousModel: initial, source: "set" },
      host.createContext({ model }),
    );
    expect(host.getActiveTools()).not.toContain("enabled");
    expect(host.getRegisteredTools().get("exec")?.definition.description).not.toContain(
      "### `enabled`",
    );
  });

  it.each(["direct", "code_mode", "code_mode_only"] as const)(
    "places tasks and dynamically loaded MCP tools in %s",
    async (mode) => {
      await t.writeConfig({ mcpServers: { fixture: fixtureServer("mixed") } });
      let sources = (): ToolInventory[] => [];

      const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: mode };

      const host = t.createExtensionHost(
        (pi) => {
          registerFallbackCodexTools(pi);
          backgroundTasks(pi);
          mcp(pi);
          sources = () => collectContributions(pi);
        },
        { model, hasUI: false },
      );

      await host.emitSessionStart();
      const ctx = host.createContext({ ui: { select: async () => "○ fixture" } });
      await host.runCommand("mcp", "", ctx);
      expect(host.getNotifications().some((note) => note.type === "error")).toBe(false);
      const name = toGeneratedToolName("fixture", "search");
      expect(host.getActiveTools().includes(name)).toBe(mode !== "code_mode_only");
      expect(host.getActiveTools().includes("task_list")).toBe(mode !== "code_mode_only");
      const description = host.getRegisteredTools().get("exec")?.definition.description;

      if (mode === "direct") expect(description).toBeUndefined();
      else {
        expect(description).toContain(name);
        expect(description).toContain('"query"');
        expect(description).toContain("After task_start");
      }

      const tool = sources()
        .flatMap((source) => source.tools)
        .find(({ definition }) => definition.name === name);

      if (!tool) throw new Error("Missing MCP contribution");

      const result = await toNestedTool(tool).invoke(
        { query: "before" },
        { cellId: "test-cell", extensionContext: ctx },
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        content: [
          { type: "text", text: "before" },
          { type: "image" },
          { type: "text", text: "after image" },
          { type: "text", text: JSON.stringify({ query: "before" }, null, 2) },
        ],
      });

      await host.runCommand(
        "mcp",
        "",
        host.createContext({ ui: { select: async () => "● fixture (reconnect)" } }),
      );
      await expect(
        toNestedTool(tool).invoke(
          { query: "stale" },
          { cellId: "test-cell", extensionContext: ctx },
          new AbortController().signal,
        ),
      ).rejects.toThrow("no longer available");

      if (mode !== "direct")
        expect(host.getRegisteredTools().get("exec")?.definition.description).toContain(name);
      host.setLeafId(null);
      await host.emitSessionTree();

      if (mode !== "direct")
        expect(host.getRegisteredTools().get("exec")?.definition.description).not.toContain(name);
      else expect(host.getRegisteredTools().has("exec")).toBe(false);
    },
  );

  it.each(["sampling", "sampling-error"])(
    "drains MCP accounting exactly once after %s",
    async (scenario) => {
      const fixture = await t.startHttpFixture({ scenario });
      await t.writeConfig({ mcpServers: { sample: { type: "http", url: fixture.url } } });

      const usage = {
        input: 7,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      let sources = (): ToolInventory[] => [];

      const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode_only" };

      const host = t.createExtensionHost(
        (pi) => {
          mcp(pi);
          registerFallbackCodexTools(pi);
          sources = () => collectContributions(pi);
          pi.events.on("clanker-codex:sampling-scope-request", (request) => {
            // SAFETY: The real MCP producer emits this request in this isolated host.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The actual MCP producer is the sole emitter in this isolated test host.
            const typed = request as SamplingScopeRequest;
            typed.resolve(
              Promise.resolve({
                run: <T>(run: () => T) => run(),
                boundText: (text: string) => text,
                dispose: async () => {},
                status: { limitReached: false, usageComplete: true, usage },
              }),
            );
          });
        },
        { model, hasUI: false },
      );

      await host.emitSessionStart();

      const ctx = host.createContext({
        ui: { select: async () => "○ sample" },
        modelRegistry: { complete: vi.fn(async () => fauxAssistantMessage("sample")) },
      });

      await host.runCommand("mcp", "", ctx);
      expect(host.getNotifications().some((note) => note.type === "error")).toBe(false);
      const descriptor = sources().flatMap((source) => source.tools)[0];

      if (!descriptor) throw new Error("Missing MCP contribution");
      const accounting: ToolAccounting[] = [];

      const call = toNestedTool(descriptor, (entry) => accounting.push(entry)).invoke(
        { maxTokens: 8, rounds: 1 },
        { cellId: "test-cell", extensionContext: ctx, toolCallId: "nested-call" },
        new AbortController().signal,
      );

      if (scenario === "sampling-error") await expect(call).rejects.toThrow();
      else await call;
      expect(accounting).toMatchObject([{ usage, details: { sampling: [{ complete: true }] } }]);
      expect(descriptor.takeAccounting?.("nested-call")).toBeUndefined();
    },
  );

  it("rejects reserved and normalized duplicate callable names", () => {
    const runtime = new CodeModeRuntime();

    const definition = (name: string) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    });

    expect(() => runtime.prepareNestedTools([{ definition: definition("exec") }])()).toThrow(
      "reserved",
    );
    expect(() =>
      runtime.prepareNestedTools([
        { definition: definition("a-b") },
        { definition: definition("a_b") },
      ])(),
    ).toThrow("Duplicate");
  });
});
