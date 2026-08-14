import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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

import { mcpResultToPiContent } from "../bridge.js";
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

  it("coalesces concurrent initial loads for one server", async () => {
    const connection = Promise.withResolvers<McpClientConnection>();
    const connectionFactory = vi.fn<McpConnectionFactory>(
      async () => await connection.promise
    );
    const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
    const setActiveTools = vi.fn<ExtensionAPI["setActiveTools"]>();
    const pool = new McpServerPool();
    const options = {
      connectionFactory,
      interactive: false,
      pi: {
        getActiveTools: () => [],
        getAllTools: () => [],
        registerTool,
        setActiveTools,
      } as unknown as ExtensionAPI,
      serverName: "shared",
      ui: { notify: vi.fn<ExtensionCommandContext["ui"]["notify"]>() },
    };

    const first = pool.loadServer(options);
    const second = pool.loadServer(options);
    connection.resolve({
      client: {
        listTools: async () => ({ tools: [] }),
      } as unknown as Client,
      close: vi.fn<() => Promise<void>>(async () => {}),
      transport: {} as Transport,
    });

    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      { serverName: "shared", toolCount: 0, toolNames: [] },
      { serverName: "shared", toolCount: 0, toolNames: [] },
    ]);
    expect(connectionFactory).toHaveBeenCalledOnce();
    await pool.closeAll();
  });

  it("does not keep a canceled caller behind a shared load", async () => {
    const connection = Promise.withResolvers<McpClientConnection>();
    const connectionFactory = vi.fn<McpConnectionFactory>(
      async () => await connection.promise
    );
    const pool = new McpServerPool();
    const pi = {
      getActiveTools: () => [],
      getAllTools: () => [],
      registerTool: vi.fn<ExtensionAPI["registerTool"]>(),
      setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>(),
    } as unknown as ExtensionAPI;
    const options = {
      connectionFactory,
      interactive: false,
      pi,
      serverName: "shared",
      ui: { notify: vi.fn<ExtensionCommandContext["ui"]["notify"]>() },
    };
    const first = pool.loadServer(options);
    const controller = new AbortController();
    const queued = pool.loadServer({ ...options, signal: controller.signal });

    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(connectionFactory).toHaveBeenCalledOnce();
    connection.resolve({
      client: {
        listTools: async () => ({ tools: [] }),
      } as unknown as Client,
      close: vi.fn<() => Promise<void>>(async () => {}),
      transport: {} as Transport,
    });
    await first;
    await pool.closeAll();
  });

  it("retries a failed concurrent load with the later caller's options", async () => {
    const firstAttempt = Promise.withResolvers<null>();
    const connectionFactory = vi.fn<McpConnectionFactory>(
      async (interactive) => {
        if (!interactive) {
          await firstAttempt.promise;
          throw new Error("background authorization failed");
        }
        return {
          client: {
            listTools: async () => ({ tools: [] }),
          } as unknown as Client,
          close: vi.fn<() => Promise<void>>(async () => {}),
          transport: {} as Transport,
        };
      }
    );
    const pool = new McpServerPool();
    const pi = {
      getActiveTools: () => [],
      getAllTools: () => [],
      registerTool: vi.fn<ExtensionAPI["registerTool"]>(),
      setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>(),
    } as unknown as ExtensionAPI;
    const ui = { notify: vi.fn<ExtensionCommandContext["ui"]["notify"]>() };

    const background = pool.loadServer({
      connectionFactory,
      interactive: false,
      pi,
      serverName: "shared",
      ui,
    });
    const interactive = pool.loadServer({
      connectionFactory,
      interactive: true,
      pi,
      serverName: "shared",
      ui,
    });
    firstAttempt.resolve(null);

    await expect(background).rejects.toThrow("background authorization failed");
    await expect(interactive).resolves.toMatchObject({ serverName: "shared" });
    expect(connectionFactory.mock.calls.map(([value]) => value)).toStrictEqual([
      false,
      true,
    ]);
    await pool.closeAll();
  });

  it("preserves valid structured tool content", () => {
    const converted = mcpResultToPiContent({
      content: [],
      structuredContent: { count: 2, items: ["a", "b"] },
    });

    expect(converted.content).toContainEqual({
      text: JSON.stringify({ count: 2, items: ["a", "b"] }, null, 2),
      type: "text",
    });
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
        select: vi.fn<() => Promise<string>>(async () => "○ remote"),
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
        select: vi.fn<() => Promise<string>>(async () => "○ remote"),
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
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
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
      outputPath: expect.stringContaining("/data/mcp/results/"),
      serverName: "github",
      toolName: "search",
      truncated: true,
    });
    const overflow = await readFile(
      (result.details as { outputPath: string }).outputPath,
      "utf-8"
    );
    expect(Buffer.byteLength(overflow)).toBeGreaterThan(50_000);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        (result.details as { outputPath: string }).outputPath
      ),
    });
    expect(JSON.stringify(result)).not.toContain("mcpResult");
  });

  it("caps oversized persisted outputs and aggregate retention", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer("oversize") },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });
    await host.runCommand("mcp", "", ctx);

    await Promise.all(
      Array.from(
        { length: 6 },
        async (_, index) =>
          await host.runTool("mcp_github__search", { query: String(index) })
      )
    );
    const latest = await host.runTool("mcp_github__search", {
      query: "latest",
    });
    const latestPath = (latest.details as { outputPath: string }).outputPath;
    const resultDirectory = path.join(t.dataDir, "results");
    const entries = await readdir(resultDirectory);
    const files = await Promise.all(
      entries.map(
        async (entry) => await stat(path.join(resultDirectory, entry))
      )
    );

    expect({
      count: entries.length,
      hasLatest: entries.includes(path.basename(latestPath)),
      perFileBounded: files.every((file) => file.size <= 1024 * 1024),
      totalBounded:
        files.reduce((total, file) => total + file.size, 0) <= 5 * 1024 * 1024,
    }).toStrictEqual({
      count: 5,
      hasLatest: true,
      perFileBounded: true,
      totalBounded: true,
    });
    const latestOutput = await readFile(latestPath, "utf-8");
    expect(latestOutput).not.toContain("�");
    expect(latestOutput).toMatch(
      /^😀+[\s\S]*\[MCP persisted output truncated\]\n$/u
    );
    expect(latest.content[0]).toMatchObject({
      text: expect.stringContaining("persisted output:"),
    });
    expect(JSON.stringify(latest.content)).not.toContain("full output:");
  });

  it("retains only the ten newest persisted outputs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1);
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

    const paths: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- call order defines retention age
      const result = await host.runTool("mcp_github__search", {
        query: String(index),
      });
      paths.push((result.details as { outputPath: string }).outputPath);
    }
    const entries = await readdir(path.join(t.dataDir, "results"));

    expect(entries).toHaveLength(10);
    expect(entries).toContain(path.basename(paths.at(-1) ?? ""));
    expect(
      paths.filter((file) => entries.includes(path.basename(file)))
    ).toHaveLength(10);
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
      await host.runTool("mcp_github__search", { query: "anything" });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : "";
    const outputPath = /persisted output: (?<path>[^;\]]+)/u.exec(message)
      ?.groups?.path;

    expect(message).toMatch(
      /returned an error: failure[\s\S]*\[MCP output truncated: kept .*\]\n\[image:image\/png\]$/u
    );
    expect(outputPath).toBeTypeOf("string");
    await expect(readFile(outputPath ?? "", "utf-8")).resolves.toContain(
      "failure\nfailure\n"
    );
  });

  it("rejects generated tool-name collisions", async () => {
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

    expect(host.getRegisteredTools().size).toBe(0);
    expect(host.getNotifications()).toContainEqual({
      message: expect.stringContaining("MCP tool name collision"),
      type: "error",
    });
  });
});
