import { Type } from "@earendil-works/pi-ai";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionCommandContext,
  MarkdownTransformer,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "./extension-host.js";
import { createCustomUiDriver } from "./tui.js";

const setupHost = () =>
  createExtensionHost((pi: ExtensionAPI) => {
    pi.registerCommand("test-command", {
      description: "Test command",
      handler: async (_args, ctx) => {
        ctx.ui.setWidget("status", ["command ran"]);
        ctx.ui.notify("command complete", "info");

        await Promise.resolve();
      },
    });

    pi.registerTool({
      description: "Tool for tests",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        await Promise.resolve();
        ctx.ui.notify(`tool:${params.value}`, "info");
        return {
          content: [{ text: params.value, type: "text" }],
          details: { echoed: params.value },
        };
      },
      label: "Test tool",
      name: "test-tool",
      parameters: Type.Object({ value: Type.String() }),
    });

    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("started", "info");
    });

    pi.on("session_tree", (_event, ctx) => {
      ctx.ui.setWidget("tree", [ctx.sessionManager.getLeafId() ?? "none"]);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      ctx.ui.notify("stopped", "warning");
    });

    pi.on("input", async (event, ctx) => {
      ctx.ui.setWidget("input", [event.text]);
      if (event.text === "custom") {
        const result = await ctx.ui.custom<string>(
          (_tui, _theme, _keybindings, done) => {
            done("from-done");
            return {
              invalidate() {
                /* noop */
              },
              render() {
                return ["custom-flow"];
              },
            };
          }
        );
        return {
          action: "transform",
          text: `${event.text}:${result}`,
        };
      }

      return {
        action: "transform",
        text: `${event.text}:transformed`,
      };
    });

    pi.on("turn_end", (_event, ctx) => {
      ctx.ui.notify("turn ended", "info");
    });
  });

describe("extension-host harness", () => {
  it("awaits async extension factories before running commands", async () => {
    const host = createExtensionHost(async (pi: ExtensionAPI) => {
      await Promise.resolve();
      pi.registerCommand("async-command", {
        description: "Async command",
        handler: async (_args, ctx) => {
          ctx.ui.notify("async command ran", "info");

          await Promise.resolve();
        },
      });
    });

    await host.runCommand("async-command");

    expect(host.getNotifications()).toContainEqual({
      message: "async command ran",
      type: "info",
    });
  });

  it("defaults lifecycle helper reasons and preserves explicit overrides", async () => {
    const sessionStarts: SessionStartEvent[] = [];
    const sessionShutdowns: SessionShutdownEvent[] = [];
    const host = createExtensionHost((pi: ExtensionAPI) => {
      pi.on("session_start", (event) => {
        sessionStarts.push(event);
      });
      pi.on("session_shutdown", (event) => {
        sessionShutdowns.push(event);
      });
    });
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await host.emitSessionShutdown(ctx);
    await host.emitSessionStart(ctx, "resume");
    await host.emitSessionShutdown(ctx, "reload");

    expect(sessionStarts).toStrictEqual([
      { reason: "startup", type: "session_start" },
      { reason: "resume", type: "session_start" },
    ]);
    expect(sessionShutdowns).toStrictEqual([
      { reason: "quit", type: "session_shutdown" },
      { reason: "reload", type: "session_shutdown" },
    ]);
  });

  it("registers commands and tools and can run them", async () => {
    const host = setupHost();
    await host.ready;

    expect([...host.getRegisteredCommands().keys()]).toStrictEqual([
      "test-command",
    ]);
    expect([...host.getRegisteredTools().keys()]).toStrictEqual(["test-tool"]);

    await host.runCommand("test-command");
    const toolResult = await host.runTool("test-tool", { value: "echo" });

    expect(host.getWidget("status")).toBe("command ran");
    expect(toolResult).toMatchObject({ details: { echoed: "echo" } });
    expect(host.getNotifications()).toContainEqual({
      message: "tool:echo",
      type: "info",
    });
  });

  it("uses loaded extension registration state for renderers, providers, and flags", async () => {
    const entryRenderer = vi.fn<EntryRenderer>();
    const markdownTransformer = vi.fn<MarkdownTransformer>(
      (markdown: string) => markdown
    );
    const nativeProvider = { id: "native-test" } as never;
    const configuredProvider = { name: "Configured test" };
    let defaultFlag: boolean | string | undefined;
    const host = createExtensionHost((pi: ExtensionAPI) => {
      pi.registerEntryRenderer("test-entry", entryRenderer);
      pi.registerMarkdownTransformer(markdownTransformer);
      pi.registerProvider(nativeProvider);
      pi.registerProvider("configured-test", configuredProvider);
      pi.registerFlag("default-on", {
        default: true,
        type: "boolean",
      });
      defaultFlag = pi.getFlag("default-on");
    });

    await host.ready;

    expect(defaultFlag).toBeTruthy();
    expect(host.getEntryRenderer("test-entry")).toBe(entryRenderer);
    expect(host.getMarkdownTransformer()).toBe(markdownTransformer);
    expect(host.getRegisteredNativeProviders().get("native-test")).toBe(
      nativeProvider
    );
    expect(host.getRegisteredProviderConfigs().get("configured-test")).toBe(
      configuredProvider
    );
  });

  it("keeps post-load tool registration in the loaded extension", async () => {
    let api: ExtensionAPI | undefined;
    const host = createExtensionHost((pi: ExtensionAPI) => {
      api = pi;
    });
    await host.ready;

    api?.registerTool({
      description: "Late tool",
      async execute() {
        await Promise.resolve();
        return { content: [{ text: "late", type: "text" }], details: {} };
      },
      label: "Late tool",
      name: "late-tool",
      parameters: Type.Object({}),
    });

    expect(host.getRegisteredTools().has("late-tool")).toBeTruthy();
    expect(host.getActiveTools()).toContain("late-tool");
  });

  it("surfaces extension loader errors through ready", async () => {
    const host = createExtensionHost(() => {
      throw new Error("factory failed");
    });

    await expect(host.ready).rejects.toThrow("factory failed");
  });

  it("auto-activates newly registered tools", async () => {
    const host = createExtensionHost(
      (pi: ExtensionAPI) => {
        pi.registerTool({
          description: "New tool",
          async execute() {
            await Promise.resolve();
            return {
              content: [{ text: "ok", type: "text" }],
              details: {},
            };
          },
          label: "New tool",
          name: "new-tool",
          parameters: Type.Object({}),
        });
      },
      { activeTools: ["read"] }
    );

    await host.ready;

    expect(host.getActiveTools()).toStrictEqual(["read", "new-tool"]);
  });

  it("does not auto-activate re-registered inactive tools", async () => {
    const host = createExtensionHost(
      (pi: ExtensionAPI) => {
        pi.registerTool({
          description: "Known tool",
          async execute() {
            await Promise.resolve();
            return {
              content: [{ text: "ok", type: "text" }],
              details: {},
            };
          },
          label: "Known tool",
          name: "known-tool",
          parameters: Type.Object({}),
        });
      },
      { activeTools: ["read"], allTools: ["read", "known-tool"] }
    );

    await host.ready;

    expect(host.getActiveTools()).toStrictEqual(["read"]);
  });

  it("applies prepareArguments before execute", async () => {
    const host = createExtensionHost((pi: ExtensionAPI) => {
      pi.registerTool({
        description: "Tool for tests",
        async execute(_toolCallId, params) {
          await Promise.resolve();
          return {
            content: [{ text: params.value, type: "text" }],
            details: { echoed: params.value },
          };
        },
        label: "Test tool",
        name: "test-tool",
        parameters: Type.Object({ value: Type.String() }),
        prepareArguments(args) {
          return {
            value: (args as { legacy?: string }).legacy ?? "",
          };
        },
      });
    });

    const result = await host.runTool("test-tool", {
      legacy: "echo",
    });

    expect(result).toMatchObject({ details: { echoed: "echo" } });
  });

  it("passes explicit tool execution options through runTool", async () => {
    const { signal } = new AbortController();
    const onUpdate = vi.fn<() => void>();
    const host = createExtensionHost((pi: ExtensionAPI) => {
      pi.registerTool({
        description: "Tool for tests",
        async execute(toolCallId, params, currentSignal, currentOnUpdate) {
          await Promise.resolve();
          currentOnUpdate?.({
            content: [{ text: "partial", type: "text" }],
          } as never);
          return {
            content: [{ text: params.value, type: "text" }],
            details: {
              signalMatches: currentSignal === signal,
              toolCallId,
            },
          };
        },
        label: "Test tool",
        name: "test-tool",
        parameters: Type.Object({ value: Type.String() }),
      });
    });

    const result = await host.runTool(
      "test-tool",
      { value: "echo" },
      {
        ctx: host.createContext(),
        onUpdate,
        signal,
        toolCallId: "tool-call-123",
      }
    );

    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ text: "partial", type: "text" }],
    });
    expect(result).toMatchObject({
      details: {
        signalMatches: true,
        toolCallId: "tool-call-123",
      },
    });
  });

  it("emits lifecycle, input, and turn events", async () => {
    const host = setupHost();
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    host.setLeafId("leaf-1");
    await host.emitSessionTree(ctx);
    const result = await host.emitInput(
      {
        source: "interactive",
        text: "hello",
        type: "input",
      },
      ctx
    );
    await host.emitTurnEnd(undefined, ctx);
    await host.emitSessionShutdown(ctx);

    expect(result).toStrictEqual({
      action: "transform",
      text: "hello:transformed",
    });
    expect(host.getWidget("tree")).toBe("leaf-1");
    expect(host.getWidget("input")).toBe("hello");
    expect(host.getNotifications()).toStrictEqual(
      expect.arrayContaining([
        { message: "started", type: "info" },
        { message: "turn ended", type: "info" },
        { message: "stopped", type: "warning" },
      ])
    );
  });

  it("supports explicit custom ui overrides", async () => {
    const host = setupHost();
    const customUi = createCustomUiDriver<string>({
      captureRender: "after",
    });
    const ctx = host.createContext({
      ui: {
        custom: vi.fn<(...args: never[]) => unknown>(
          customUi.custom
        ) as ExtensionCommandContext["ui"]["custom"],
      },
    });

    const result = await host.emitInput(
      {
        source: "interactive",
        text: "custom",
        type: "input",
      },
      ctx
    );

    expect(result).toStrictEqual({
      action: "transform",
      text: "custom:from-done",
    });
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(customUi.getLastRender()).toContain("custom-flow");
  });

  it("supports terminal input listeners", async () => {
    const host = createExtensionHost((pi: ExtensionAPI) => {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.onTerminalInput((data) => {
          ctx.ui.notify(`terminal:${data}`, "info");
        });
      });
    });

    await host.emitSessionStart();
    host.terminalInput("x");

    expect(host.getNotifications()).toContainEqual({
      message: "terminal:x",
      type: "info",
    });
  });

  it("requires tests to provide ui.custom explicitly", async () => {
    const host = createExtensionHost((pi: ExtensionAPI) => {
      pi.on("input", async (_event, ctx) => ({
        action: "transform",
        text: await ctx.ui.custom<string>(
          (_tui, _theme, _keybindings, _done) => ({
            invalidate() {
              /* noop */
            },
            render() {
              return ["picker"];
            },
          })
        ),
      }));
    });

    await expect(
      host.emitInput({
        source: "interactive",
        text: "ignored",
        type: "input",
      })
    ).rejects.toThrow(
      "Tests using ui.custom must provide ctx.ui.custom explicitly"
    );
  });

  it("throws when running an unregistered command", async () => {
    const host = setupHost();

    await expect(host.runCommand("missing-command")).rejects.toThrow(
      "Extension command not registered: missing-command"
    );
  });

  it("throws when running an unregistered tool", async () => {
    const host = setupHost();

    await expect(host.runTool("missing-tool", {})).rejects.toThrow(
      "Extension tool not registered: missing-tool"
    );
  });

  it("maintains in-memory session tree state and active tools", async () => {
    const host = createExtensionHost(
      (pi: ExtensionAPI) => {
        pi.registerCommand("append", {
          handler: async (_args, _ctx) => {
            pi.appendEntry("state", { active: true });

            await Promise.resolve();
          },
        });
      },
      {
        activeTools: ["read", "write"],
        entries: [
          {
            id: "root",
            message: {
              content: "root",
              role: "user",
              timestamp: 0,
            },
            parentId: null,
            timestamp: new Date(0).toISOString(),
            type: "message",
          },
        ],
        leafId: "root",
      }
    );

    await host.runCommand("append");

    const [appendedEntry] = host.getAppendedEntries();
    expect(appendedEntry).toMatchObject({
      customType: "state",
      data: { active: true },
      parentId: "root",
    });
    expect(host.getLeafId()).toBe(appendedEntry?.id);

    const ctx = host.createContext();
    expect(ctx.sessionManager.getBranch()).toStrictEqual([
      expect.objectContaining({ id: "root" }),
      expect.objectContaining({ id: appendedEntry?.id }),
    ]);

    host.setActiveTools(["bash"]);
    expect(host.getActiveTools()).toStrictEqual(["bash"]);
  });
});
