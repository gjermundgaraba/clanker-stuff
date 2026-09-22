import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo, initTheme } from "@earendil-works/pi-coding-agent";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { renderedRows, toolRenderContext } from "../../../tests/harness/tool-rendering.js";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { mcpRenderers } from "../renderers.js";
import { toGeneratedToolName } from "../bridge.js";
import type { McpClient, McpClientConnection, McpConnectionFactory } from "../connection.js";
import mcp from "../index.js";
import { McpServerPool } from "../servers.js";
import type { McpToolRegistry } from "../servers.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

beforeAll(() => initTheme("dark"));

const PersistedMcpToolDetailsSchema = Type.Object({ outputPath: Type.String() });

const createToolRegistry = (onRegister?: McpToolRegistry["registerTool"]): McpToolRegistry => ({
  getAllTools: () => [],
  registerTool(tool) {
    onRegister?.(tool);
  },
  setEnabled: vi.fn<McpToolRegistry["setEnabled"]>(),
});

const createEmptyClient = (): McpClient => ({
  ping: vi.fn<McpClient["ping"]>(async () => ({})),
  callTool: vi.fn<McpClient["callTool"]>(async () => ({ content: [] })),
  listTools: vi.fn<McpClient["listTools"]>(async () => ({ tools: [] })),
});

type RegisteredToolExecutor = (
  toolCallId: string,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;

describe("mcp server pool", () => {
  const t = setupMcpTest();

  it("publishes one enabled inventory after a complete multi-tool discovery", async () => {
    const registry = createToolRegistry();
    const pool = new McpServerPool(registry);

    const definitions = Array.from({ length: 100 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: { type: "object" as const },
    }));

    await pool.loadServer({
      serverName: "many",
      interactive: false,
      connectionFactory: async () => ({
        client: { ...createEmptyClient(), listTools: async () => ({ tools: definitions }) },
        close: async () => {},
        transport: {},
      }),
    });
    expect(registry.setEnabled).toHaveBeenCalledTimes(1);
    expect(registry.setEnabled).toHaveBeenCalledWith(
      definitions.map(({ name }) => toGeneratedToolName("many", name)),
    );
    await pool.closeAll();
  });

  it("closes a late connection and skips queued reconnects during shutdown", async () => {
    const connection = Promise.withResolvers<McpClientConnection>();
    const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const pool = new McpServerPool(createToolRegistry());

    const load = pool.loadServer({
      connectionFactory: () => connection.promise,
      interactive: false,
      serverName: "slow",
    });

    const queuedFactory = vi.fn<McpConnectionFactory>();

    const queued = pool.loadServer({
      connectionFactory: queuedFactory,
      interactive: false,
      serverName: "slow",
      reconnect: true,
    });

    const shutdown = pool.closeAll();
    connection.resolve({
      client: createEmptyClient(),
      close,
      transport: {},
    });

    await expect(load).rejects.toThrow("This operation was aborted");
    await expect(queued).rejects.toThrow("This operation was aborted");
    await shutdown;
    expect(close).toHaveBeenCalledOnce();
    expect(queuedFactory).not.toHaveBeenCalled();
  });

  it("reuses a healthy connection for queued ordinary connects", async () => {
    const connection = Promise.withResolvers<McpClientConnection>();
    const connectionFactory = vi.fn<McpConnectionFactory>(async () => await connection.promise);
    const pool = new McpServerPool(createToolRegistry());

    const options = {
      connectionFactory,
      interactive: false,
      serverName: "shared",
    };

    const first = pool.loadServer(options);
    const second = pool.loadServer(options);
    connection.resolve({
      client: createEmptyClient(),
      close: vi.fn<() => Promise<void>>(async () => {}),
      transport: {},
    });

    await expect(Promise.all([first, second])).resolves.toStrictEqual([0, 0]);
    expect(connectionFactory).toHaveBeenCalledOnce();
    await pool.closeAll();
  });

  it("cancels a queued reconnect without starting it", async () => {
    const connection = Promise.withResolvers<McpClientConnection>();
    const connectionFactory = vi.fn<McpConnectionFactory>(async () => await connection.promise);
    const pool = new McpServerPool(createToolRegistry());

    const options = {
      connectionFactory,
      interactive: false,
      serverName: "shared",
    };

    const first = pool.loadServer(options);
    const controller = new AbortController();
    const canceledFactory = vi.fn<McpConnectionFactory>();

    const queued = pool.loadServer({
      ...options,
      reconnect: true,
      connectionFactory: canceledFactory,
      signal: controller.signal,
    });

    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(connectionFactory).toHaveBeenCalledOnce();
    connection.resolve({
      client: createEmptyClient(),
      close: vi.fn<() => Promise<void>>(async () => {}),
      transport: {},
    });
    await first;
    await pool.loadServer(options);
    expect(canceledFactory).not.toHaveBeenCalled();
    await pool.closeAll();
  });

  it("serializes explicit reconnects and applies each caller's factory", async () => {
    const initial = Promise.withResolvers<McpClientConnection>();
    const old = { client: createEmptyClient(), close: vi.fn(async () => {}), transport: {} };
    const replacement = { ...old, close: vi.fn(async () => {}) };
    const factory = vi.fn<McpConnectionFactory>(async () => replacement);
    const pool = new McpServerPool(createToolRegistry());
    const options = { serverName: "remote", interactive: false };

    try {
      const first = pool.loadServer({ ...options, connectionFactory: () => initial.promise });
      const second = pool.loadServer({ ...options, reconnect: true, connectionFactory: factory });
      expect(factory).not.toHaveBeenCalled();
      initial.resolve(old);
      await Promise.all([first, second]);
      expect(old.close).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      initial.resolve(old);
      await pool.closeAll();
    }
  });

  it("runs the next requested connection after its predecessor fails", async () => {
    const firstAttempt = Promise.withResolvers<null>();

    const connectionFactory = vi.fn<McpConnectionFactory>(async (interactive) => {
      if (!interactive) {
        await firstAttempt.promise;
        throw new Error("background authorization failed");
      }

      return {
        client: createEmptyClient(),
        close: vi.fn<() => Promise<void>>(async () => {}),
        transport: {},
      };
    });

    const pool = new McpServerPool(createToolRegistry());

    const background = pool.loadServer({
      connectionFactory,
      interactive: false,
      serverName: "shared",
    });

    const interactive = pool.loadServer({
      connectionFactory,
      interactive: true,
      serverName: "shared",
    });

    firstAttempt.resolve(null);

    await expect(background).rejects.toThrow("background authorization failed");
    await expect(interactive).resolves.toBe(0);
    expect(connectionFactory.mock.calls.map(([value]) => value)).toStrictEqual([false, true]);
    await pool.closeAll();
  });

  it("replaces tools, deactivates disconnected servers, and permits removed tools to return", async () => {
    const tools = new Map<string, ToolInfo>();
    let active: string[] = [];

    const pi: McpToolRegistry = {
      getAllTools: () => [...tools.values()],
      registerTool: (tool) => {
        tools.set(tool.name, {
          name: tool.name,
          parameters: tool.parameters,
          description: tool.description,
          sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }),
        });
      },
      setEnabled: (names) => {
        active = [...names];
      },
    };

    const pool = new McpServerPool(pi);

    const makeConnection = (name: string) => {
      const closed = new AbortController();

      return {
        client: {
          ...createEmptyClient(),
          listTools: async () => ({ tools: [{ name, inputSchema: { type: "object" as const } }] }),
        },
        close: vi.fn(async () => {
          closed.abort();
        }),
        closed: closed.signal,
        transport: {},
      };
    };

    const first = makeConnection("first");
    const second = makeConnection("second");
    const options = { serverName: "remote", interactive: false };

    try {
      await pool.loadServer({ ...options, connectionFactory: async () => first });
      await pool.loadServer({ ...options, reconnect: true, connectionFactory: async () => second });
      expect(first.close).toHaveBeenCalledOnce();
      expect(active).toEqual([toGeneratedToolName("remote", "second")]);
      await second.close();
      expect(pool.hasServer("remote")).toBe(false);
      expect(active).toEqual([]);
      await expect(
        pool.loadServer({
          ...options,
          connectionFactory: async () => {
            throw new Error("unavailable");
          },
        }),
      ).rejects.toThrow("unavailable");
      expect(active).toEqual([]);
      await pool.loadServer({ ...options, connectionFactory: async () => makeConnection("first") });
      expect(active).toEqual([toGeneratedToolName("remote", "first")]);
      pool.reconcileActiveServers([]);
      expect(active).toEqual([]);
    } finally {
      await pool.closeAll();
    }
  });

  it("rejects collisions with tools owned outside the pool", async () => {
    const name = toGeneratedToolName("remote", "search");
    const pi = createToolRegistry();
    pi.getAllTools = () => [
      {
        name,
        description: "external",
        parameters: Type.Object({}),
        sourceInfo: createSyntheticSourceInfo("<external>", { source: "test" }),
      },
    ];
    const close = vi.fn(async () => {});
    const pool = new McpServerPool(pi);
    await expect(
      pool.loadServer({
        serverName: "remote",
        interactive: false,
        connectionFactory: async () => ({
          close,
          transport: {},
          client: {
            ...createEmptyClient(),
            listTools: async () => ({
              tools: [{ name: "search", inputSchema: { type: "object" } }],
            }),
          },
        }),
      }),
    ).rejects.toThrow("MCP tool name collision");
    expect(close).toHaveBeenCalledOnce();
    await pool.closeAll();
  });

  it.each([500, 404, 403])(
    "does not replay uncertain HTTP %s failures without an expired session",
    async (status) => {
      const callTool = vi.fn<McpClient["callTool"]>(async () => {
        throw new SdkHttpError(SdkErrorCode.SendFailed, "uncertain result", { status });
      });

      const connectionFactory = vi.fn<McpConnectionFactory>(async () => ({
        client: {
          ...createEmptyClient(),
          callTool,
          listTools: async () => ({ tools: [{ name: "mutate", inputSchema: { type: "object" } }] }),
        },
        close: async () => {},
        transport: {},
      }));

      const ctx = t.createExtensionHost(() => {}).createContext();
      let execute: RegisteredToolExecutor | undefined;

      const pool = new McpServerPool(
        createToolRegistry((definition) => {
          execute = (id, signal) =>
            definition.execute(id, Value.Parse(definition.parameters, {}), signal, undefined, ctx);
        }),
      );

      try {
        await pool.loadServer({
          connectionFactory,
          serverName: "remote",
          interactive: false,
        });

        if (!execute) throw new Error("Tool not registered");
        await expect(execute("call")).rejects.toThrow("uncertain result");
        expect(callTool).toHaveBeenCalledOnce();
        expect(pool.hasServer("remote")).toBe(true);
        expect(connectionFactory).toHaveBeenCalledOnce();
      } finally {
        await pool.closeAll();
      }
    },
  );

  it("loads tools from a real streamable HTTP server", async () => {
    const fixture = await t.startHttpFixture();
    await t.writeConfig({
      mcpServers: {
        remote: { type: "http", url: fixture.url },
      },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });

    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ remote"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    const result = await host.runTool(toGeneratedToolName("remote", "search"), {
      query: "http-needle",
    });

    expect(host.getRegisteredTools().has(toGeneratedToolName("remote", "search"))).toBeTruthy();
    expect(result.content).toContainEqual({
      text: "result: http-needle",
      type: "text",
    });
  });

  it("recovers an expired session automatically without replay", async () => {
    const fixture = await t.startHttpFixture({ expireSessionOnce: true });
    await t.writeConfig({
      mcpServers: {
        remote: { type: "http", url: fixture.url },
      },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });

    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ remote"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    const name = toGeneratedToolName("remote", "search");
    await expect(host.runTool(name, { query: "expired" })).rejects.toThrow("session expired");
    expect(host.getActiveTools()).not.toContain(name);
    expect(fixture.getToolCallCount()).toBe(1);
    await expect.poll(() => host.getActiveTools()).toContain(name);

    const result = await host.runTool(toGeneratedToolName("remote", "search"), {
      query: "after-reconnect",
    });

    expect(result.content).toContainEqual({
      text: "result: after-reconnect",
      type: "text",
    });
    expect(fixture.getInitializationCount()).toBe(2);
  });

  it("truncates large tool results and keeps compact details", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer("large") },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });

    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    const result = await host.runTool(toGeneratedToolName("github", "search"), {
      query: "anything",
    });

    expect(
      result.content.some(
        (item) => item.type === "text" && item.text.includes("[MCP output truncated:"),
      ),
    ).toBe(true);
    const details = Value.Parse(PersistedMcpToolDetailsSchema, result.details);
    expect(details.outputPath).toContain("/data/mcp/results/");
    expect(result.details).toStrictEqual({
      outputPath: details.outputPath,
      overflowNoticeIndex: result.content.length - 1,
      serverName: "github",
      toolName: "search",
      truncated: true,
    });
    const overflow = await readFile(details.outputPath, "utf-8");
    expect(Buffer.byteLength(overflow)).toBeGreaterThan(50_000);
    expect(
      result.content.some((item) => item.type === "text" && item.text.includes(details.outputPath)),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("mcpResult");
    const original = structuredClone(result);

    for (const expanded of [false, true]) {
      const rows = renderedRows(
        mcpRenderers("github", "search").renderResult(
          result,
          { expanded, isPartial: false },
          createIdentityTheme(),
          toolRenderContext({ expanded }),
        ),
        200,
      );

      const display = rows.join("\n");
      expect(display.match(/MCP output truncated:/gu)).toHaveLength(1);
      expect(display.match(/Persisted output:/gu)).toHaveLength(1);
      expect(rows[0]).toContain("total text]");
      expect(rows[1]).toContain("[Persisted output:");
      expect(display.replace(/\s/gu, "")).toContain(details.outputPath.replace(/\s/gu, ""));
      expect(display.replace(/\s+/gu, " ")).toContain("temporary, may be partial");
    }

    expect(result).toEqual(original);
  });

  it("preserves success when overflow persistence fails", async () => {
    await t.writeConfig({ mcpServers: { github: fixtureServer("large") } });
    await mkdir(t.dataDir, { recursive: true });
    await writeFile(path.join(t.dataDir, "results"), "not a directory");
    const host = t.createExtensionHost(mcp, { hasUI: false });
    await host.runCommand(
      "mcp",
      "",
      host.createContext({ ui: { select: async () => "○ github" } }),
    );
    const result = await host.runTool(toGeneratedToolName("github", "search"), { query: "once" });
    expect(
      result.content.some(
        (item) =>
          item.type === "text" && item.text.includes("remote operation has already completed"),
      ),
    ).toBe(true);
    expect(result.details).toMatchObject({
      truncated: true,
      overflowNoticeIndex: result.content.length - 1,
    });

    for (const expanded of [false, true]) {
      const rows = renderedRows(
        mcpRenderers("github", "search").renderResult(
          result,
          { expanded, isPartial: false },
          createIdentityTheme(),
          toolRenderContext({ expanded }),
        ),
        200,
      );

      const display = rows.join("\n");
      expect(display.match(/MCP output truncated:/gu)).toHaveLength(1);
      expect(display.match(/Could not persist overflow/gu)).toHaveLength(1);
      expect(rows[0]).toContain("total text]");
      expect(rows[1]).toContain("do not retry solely for this warning");
      expect(display).not.toContain("Persisted output:");
    }
  });

  it("persists truncated tool errors and includes their path", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer("error") },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });

    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    let failure: unknown;

    try {
      await host.runTool(toGeneratedToolName("github", "search"), { query: "anything" });
    } catch (error) {
      failure = error;
    }

    const message = failure instanceof Error ? failure.message : "";
    const outputPath = /Persisted output: (?<path>[^;\]]+)/u.exec(message)?.groups?.path;

    expect(message).toContain("returned an error: failure");
    expect(message).toContain("[MCP output truncated:");
    expect(message).toContain("[image:image/png]");
    expect(outputPath).toBeTypeOf("string");
    await expect(readFile(outputPath ?? "", "utf-8")).resolves.toContain("failure\nfailure\n");
  });

  it("loads distinct tools that previously collided during normalization", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer("collision") },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });

    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    expect(host.getRegisteredTools().size).toBe(2);

    for (const { definition } of host.getRegisteredTools().values()) {
      expect(definition.renderCall).toBeTypeOf("function");
      expect(definition.renderResult).toBeTypeOf("function");
    }

    expect(host.getRegisteredTools().has(toGeneratedToolName("github", "foo-bar"))).toBe(true);
    expect(host.getRegisteredTools().has(toGeneratedToolName("github", "foo_bar"))).toBe(true);
  });
});
