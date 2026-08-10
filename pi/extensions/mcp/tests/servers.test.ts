import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Client, Transport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import type {
  McpClientConnection,
  McpConnectionFactory,
} from "../connection.js";
import mcp from "../index.js";
import { McpServerPool } from "../servers.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

describe("mcp server pool", () => {
  const t = setupMcpTest();

  it("closes a connection that finishes loading during shutdown", async () => {
    const connection = Promise.withResolvers<McpClientConnection>();
    const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>();
    const pool = new McpServerPool();
    const load = pool.loadServer({
      connectionFactory: () => connection.promise,
      interactive: false,
      pi: {} as ExtensionAPI,
      serverName: "slow",
      ui: { notify },
    });

    const shutdown = pool.closeAll();
    connection.resolve({
      client: {} as Client,
      close,
      transport: {} as Transport,
    });

    await expect(load).rejects.toThrow("This operation was aborted");
    await shutdown;
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a shared reconnect alive when one caller is aborted", async () => {
    const replacement = Promise.withResolvers<McpClientConnection>();
    const reconnectStarted = Promise.withResolvers<AbortSignal | undefined>();
    const expired = new SdkHttpError(SdkErrorCode.SendFailed, "expired", {
      status: 404,
    });
    const staleCallTool = vi.fn<() => Promise<never>>(async () => {
      throw expired;
    });
    const staleConnection: McpClientConnection = {
      client: {
        callTool: staleCallTool,
        listTools: async () => ({
          tools: [{ inputSchema: { type: "object" }, name: "search" }],
        }),
      } as unknown as Client,
      close: vi.fn<() => Promise<void>>(async () => {}),
      transport: new StreamableHTTPClientTransport(
        new URL("http://localhost/mcp"),
        { sessionId: "expired" }
      ),
    };
    const replacementConnection: McpClientConnection = {
      client: {
        callTool: async (
          _request: unknown,
          options?: { signal?: AbortSignal }
        ) => {
          options?.signal?.throwIfAborted();
          return { content: [{ text: "ok", type: "text" }] };
        },
      } as unknown as Client,
      close: vi.fn<() => Promise<void>>(async () => {}),
      transport: {} as Transport,
    };
    let connects = 0;
    const connectionFactory = vi.fn<McpConnectionFactory>(
      async (_interactive, signal) => {
        connects += 1;
        if (connects === 1) {
          return staleConnection;
        }
        reconnectStarted.resolve(signal);
        return await replacement.promise;
      }
    );
    let tool: ToolDefinition | undefined;
    const pool = new McpServerPool();
    await pool.loadServer({
      connectionFactory,
      interactive: false,
      pi: {
        getActiveTools: () => [],
        getAllTools: () => [],
        registerTool: (definition: ToolDefinition) => {
          tool = definition;
        },
        setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>(),
      } as unknown as ExtensionAPI,
      serverName: "remote",
      ui: {
        notify: vi.fn<ExtensionCommandContext["ui"]["notify"]>(),
      },
    });
    if (!tool) {
      throw new Error("MCP tool was not registered");
    }

    const firstController = new AbortController();
    const first = tool.execute(
      "first",
      {},
      firstController.signal,
      undefined,
      {} as ExtensionContext
    );
    const reconnectSignal = await reconnectStarted.promise;
    const second = tool.execute(
      "second",
      {},
      undefined,
      undefined,
      {} as ExtensionContext
    );
    await vi.waitFor(() => {
      expect(staleCallTool).toHaveBeenCalledTimes(2);
    });

    firstController.abort();
    replacement.resolve(replacementConnection);

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({
      content: [{ text: "ok", type: "text" }],
    });
    expect(reconnectSignal?.aborted).toBeFalsy();
    await pool.closeAll();
  });

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
        select: vi.fn<() => Promise<string>>(async () => "remote"),
      },
    });

    await host.runCommand("mcp", "", ctx);
    const result = await host.runTool("mcp_remote__search", {
      query: "http-needle",
    });

    expect(host.getRegisteredTools().has("mcp_remote__search")).toBeTruthy();
    expect(result.content).toContainEqual({
      text: "result: http-needle",
      type: "text",
    });
  });

  it("starts a new session after a session request receives HTTP 404", async () => {
    const fixture = await t.startHttpFixture(false, true);
    await t.writeConfig({
      mcpServers: {
        remote: { type: "http", url: fixture.url },
      },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "remote"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    const result = await host.runTool("mcp_remote__search", {
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
        select: vi.fn<() => Promise<string>>(async () => "github"),
      },
    });
    await host.runCommand("mcp", "", ctx);

    const result = await host.runTool("mcp_github__search", {
      query: "anything",
    });

    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("[MCP output truncated:"),
      type: "text",
    });
    expect(result.details).toStrictEqual({
      serverName: "github",
      toolName: "search",
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain("mcpResult");
  });

  it("rejects generated tool-name collisions", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer("collision") },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    expect(host.getRegisteredTools().size).toBe(0);
    expect(host.getNotifications()).toContainEqual({
      message: expect.stringContaining("MCP tool name collision"),
      type: "error",
    });
  });
});
