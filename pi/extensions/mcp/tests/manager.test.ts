import { toGeneratedToolName } from "../bridge.js";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import { MCP_MANAGER_SERVER_NAME } from "../manager.js";
import { envVarRef, fixtureServer, setupMcpTest } from "./helpers.js";

describe("mcp manager", () => {
  const t = setupMcpTest();

  it("sets, lists, and removes raw config through the manager", async () => {
    const host = await t.loadManager({ cwd: t.projectDir });
    for (const { definition } of host.getRegisteredTools().values()) {
      expect(definition.renderCall).toBeTypeOf("function");
      expect(definition.renderResult).toBeTypeOf("function");
    }

    await host.runTool("mcp_set", {
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
    const listed = await host.runTool("mcp_list", {});
    expect(listed.content).toContainEqual({
      text: "mcp-manager (built-in)\nraw-server (global)",
      type: "text",
    });

    await host.runTool("mcp_set", {
      config: fixtureServer(),
      name: "raw-server",
      scope: "global",
    });
    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toEqual({
      mcpServers: { "raw-server": fixtureServer() },
    });
    await expect(
      host.runTool("mcp_set", {
        config: fixtureServer(),
        name: MCP_MANAGER_SERVER_NAME,
        scope: "global",
      }),
    ).rejects.toThrow("is reserved");

    await host.runTool("mcp_remove", {
      name: "raw-server",
      scope: "global",
    });
    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toStrictEqual({
      mcpServers: {},
    });
  });

  it("removes a persisted collision with the built-in manager", async () => {
    await t.writeConfig({
      mcpServers: {
        [MCP_MANAGER_SERVER_NAME]: fixtureServer(),
      },
    });
    const host = await t.loadManager();

    await host.runTool("mcp_remove", {
      name: MCP_MANAGER_SERVER_NAME,
      scope: "global",
    });

    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toStrictEqual({
      mcpServers: {},
    });
    expect(host.getRegisteredTools().has("mcp_connect")).toBeTruthy();
  });

  it("connects a configured server through the manager", async () => {
    vi.stubEnv("MCP_TEST_MISSING_COMMAND", undefined);
    await t.writeConfig({
      mcpServers: {
        broken: { command: envVarRef("MCP_TEST_MISSING_COMMAND"), type: "stdio" },
        github: fixtureServer(),
      },
    });
    const host = await t.loadManager();

    await host.runTool("mcp_connect", { name: "github" });
    const result = await host.runTool(toGeneratedToolName("github", "search"), {
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

  it("uses the execution context, not the context that loaded management tools", async () => {
    const host = await t.loadManager({ projectTrusted: true });
    const ctx = host.createContext({ cwd: t.projectDir, isProjectTrusted: () => false });
    await expect(
      host.runTool(
        "mcp_set",
        { name: "local", scope: "project", config: fixtureServer() },
        { ctx },
      ),
    ).rejects.toThrow("trusted project");
  });
});
