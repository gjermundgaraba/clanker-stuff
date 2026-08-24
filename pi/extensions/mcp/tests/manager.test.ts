import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import { createMcpManagerConnection, MCP_MANAGER_SERVER_NAME } from "../manager.js";
import type { McpManagerBackend } from "../manager.js";
import { envVarRef, fixtureServer, setupMcpTest } from "./helpers.js";

describe("mcp manager", () => {
  const t = setupMcpTest();

  it("adds, lists, and removes raw config through the manager", async () => {
    const host = await t.loadManager({ cwd: t.projectDir });

    await host.runTool("mcp_mcp_manager__add_mcp", {
      config: {
        command: envVarRef("MCP_TEST_COMMAND"),
        env: { TOKEN: envVarRef("MCP_TEST_TOKEN") },
        type: "stdio",
      },
      name: "raw-server",
      scope: "global",
    });

    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toStrictEqual({
      mcpServers: {
        "raw-server": {
          command: envVarRef("MCP_TEST_COMMAND"),
          env: { TOKEN: envVarRef("MCP_TEST_TOKEN") },
          type: "stdio",
        },
      },
    });
    const listed = await host.runTool("mcp_mcp_manager__list_mcps", {});
    expect(listed.content).toContainEqual({
      text: "mcp-manager (built-in)\nraw-server (global)",
      type: "text",
    });

    await expect(
      host.runTool("mcp_mcp_manager__add_mcp", {
        config: fixtureServer(),
        name: "raw-server",
        scope: "global",
      }),
    ).rejects.toThrow("already exists in the global config");
    await expect(
      host.runTool("mcp_mcp_manager__add_mcp", {
        config: fixtureServer(),
        name: MCP_MANAGER_SERVER_NAME,
        scope: "global",
      }),
    ).rejects.toThrow("is reserved");

    await host.runTool("mcp_mcp_manager__remove_mcp", {
      name: "raw-server",
      scope: "global",
    });
    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toStrictEqual({
      mcpServers: {},
    });
  });

  it("rejects project config mutations when the project is untrusted", async () => {
    const host = await t.loadManager({
      cwd: t.projectDir,
      projectTrusted: false,
    });

    await expect(
      host.runTool("mcp_mcp_manager__add_mcp", {
        config: fixtureServer(),
        name: "project-server",
        scope: "project",
      }),
    ).rejects.toThrow("requires a trusted project");
  });

  it("removes a persisted collision with the built-in manager", async () => {
    await t.writeConfig({
      mcpServers: {
        [MCP_MANAGER_SERVER_NAME]: fixtureServer(),
      },
    });
    const host = await t.loadManager();

    await host.runTool("mcp_mcp_manager__remove_mcp", {
      name: MCP_MANAGER_SERVER_NAME,
      scope: "global",
    });

    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toStrictEqual({
      mcpServers: {},
    });
    expect(host.getRegisteredTools().has("mcp_mcp_manager__connect")).toBeTruthy();
  });

  it("connects a configured server through the manager", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer() },
    });
    const host = await t.loadManager();

    await host.runTool("mcp_mcp_manager__connect", { name: "github" });
    const result = await host.runTool("mcp_github__search", {
      query: "managed",
    });

    expect(result.content).toContainEqual({
      text: "result: managed",
      type: "text",
    });
    expect(host.getAppendedEntries()).toMatchObject([
      {
        customType: "mcp-server-loaded",
        data: { serverName: MCP_MANAGER_SERVER_NAME },
      },
      {
        customType: "mcp-server-loaded",
        data: { serverName: "github" },
      },
    ]);
  });

  it("forwards manager tool cancellation to its backend", async () => {
    let receivedSignal: AbortSignal | undefined;
    const backend: McpManagerBackend = {
      add: vi.fn<McpManagerBackend["add"]>(),
      connect: async (_name, signal) => {
        receivedSignal = signal;
        await once(signal, "abort");
        signal.throwIfAborted();
        return 0;
      },
      list: vi.fn<McpManagerBackend["list"]>(async () => ({ servers: [] })),
      remove: vi.fn<McpManagerBackend["remove"]>(),
    };
    const connection = await createMcpManagerConnection(backend);
    try {
      await connection.client.listTools();
      expect(connection.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const controller = new AbortController();
      const call = connection.client.callTool(
        { arguments: { name: "slow" }, name: "connect" },
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(receivedSignal).toBeDefined());

      controller.abort();

      await expect(call).rejects.toThrow(/abort/iu);
      await vi.waitFor(() => expect(receivedSignal?.aborted).toBeTruthy());
    } finally {
      await connection.close();
    }
  });
});
