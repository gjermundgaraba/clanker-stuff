import { fileURLToPath, pathToFileURL } from "node:url";
import * as connections from "../connection.js";
import { toGeneratedToolName } from "../bridge.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createCustomUiDriver } from "../../../tests/harness/tui.js";
import mcp from "../index.js";
import { MCP_MANAGER_SERVER_NAME } from "../manager.js";
import { envVarRef, fixtureServer, setupMcpTest } from "./helpers.js";

const createBranchSession = ({ chained = false }: { chained?: boolean } = {}) => {
  const timestamp = new Date().toISOString();
  return {
    entries: [
      {
        id: "root",
        message: { content: "root", role: "user", timestamp: 1 },
        parentId: null,
        timestamp,
        type: "message",
      },
      {
        customType: "mcp-server-loaded",
        data: { serverName: "alpha" },
        id: "alpha-load",
        parentId: "root",
        timestamp,
        type: "custom",
      },
      {
        customType: "mcp-server-loaded",
        data: { serverName: "beta" },
        id: "beta-load",
        parentId: chained ? "alpha-load" : "root",
        timestamp,
        type: "custom",
      },
    ] satisfies SessionEntry[],
    hasUI: false,
    leafId: chained ? "beta-load" : "alpha-load",
  };
};

describe("mcp loader", () => {
  const t = setupMcpTest();

  it("updates idle roots on a reused connection without retaining an invalidated session context", async () => {
    await t.writeConfig({
      mcpServers: {
        alpha: {
          type: "stdio",
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./fixtures/elicitation-peer.ts", import.meta.url)),
            "legacy",
            "roots",
          ],
        },
      },
    });
    const connect = connections.connectToServer;
    let connection: connections.McpClientConnection | undefined;
    const spy = vi.spyOn(connections, "connectToServer").mockImplementation(async (options) => {
      connection = await connect(options);
      return connection;
    });
    const host = t.createExtensionHost(mcp, createBranchSession());
    const original = host.createContext({ cwd: process.cwd() });
    try {
      await host.emitSessionStart(original);
      expect((await connection!.client.callTool({ name: "startup-roots" })).content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            roots: [{ uri: pathToFileURL(process.cwd()).href, name: "Workspace" }],
          }),
        },
      ]);
      Object.defineProperty(original, "cwd", {
        get: () => {
          throw new Error("original session invalidated");
        },
      });
      const next = host.createContext({ cwd: t.projectDir });
      await host.emitSessionStart(next, "resume");
      expect(spy).toHaveBeenCalledOnce();
      expect((await connection!.client.callTool({ name: "interact" })).content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            roots: [{ uri: pathToFileURL(t.projectDir).href, name: "Workspace" }],
          }),
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not open the picker when shutdown wins the first-load race", async () => {
    const host = t.createExtensionHost(mcp);
    const select = vi.fn();
    const ctx = host.createContext({ ui: { select } });
    const command = host.runCommand("mcp", "", ctx);
    await host.emitSessionShutdown(ctx);
    await command;
    expect(select).not.toHaveBeenCalled();
    expect(host.getRegisteredTools().size).toBe(0);
  });

  it("does not load servers on session_start without persisted entries", async () => {
    await t.writeConfig({ mcpServers: null });
    const host = t.createExtensionHost(mcp);

    await host.ready;
    await host.emitSessionStart();

    expect(host.getNotifications()).toStrictEqual([]);
    expect(host.getRegisteredTools().size).toBe(0);
  });

  it("shows the built-in single-select list and does nothing when cancelled", async () => {
    await t.writeConfig({
      mcpServers: {
        github: { type: "http", url: "https://mcp.example.com" },
        local: { command: "/usr/bin/mcp-local", type: "stdio" },
      },
    });
    const host = t.createExtensionHost(mcp);
    const select = vi.fn<() => Promise<string | undefined>>();
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenCalledWith("MCP server", [
      `○ ${MCP_MANAGER_SERVER_NAME}`,
      "○ github",
      "○ local",
    ]);
    expect(host.getRegisteredTools().size).toBe(0);
  });

  it("loads project-local config from the command cwd", async () => {
    await t.writeLocalConfig({
      mcpServers: { project: fixtureServer() },
    });
    const select = vi.fn<() => Promise<string>>(async () => "○ project");
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      cwd: t.projectDir,
      ui: { select },
    });

    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenCalledWith("MCP server", [
      `○ ${MCP_MANAGER_SERVER_NAME}`,
      "○ project",
    ]);
    expect(host.getRegisteredTools().has(toGeneratedToolName("project", "search"))).toBeTruthy();
  });

  it("connects the selected server and registers its tools as active", async () => {
    vi.stubEnv("MCP_TEST_MISSING_COMMAND", undefined);
    await t.writeConfig({
      mcpServers: {
        broken: { command: envVarRef("MCP_TEST_MISSING_COMMAND"), type: "stdio" },
        github: fixtureServer(),
      },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);
    const result = await host.runTool(toGeneratedToolName("github", "search"), {
      query: "needle",
    });

    expect(host.getActiveTools()).toContain(toGeneratedToolName("github", "search"));
    expect(host.getRegisteredTools().has(toGeneratedToolName("github", "search"))).toBeTruthy();
    expect(host.getNotifications()).toContainEqual({
      message: "MCP server github was loaded with 1 tools",
      type: undefined,
    });
    expect(result.content).toContainEqual({
      text: "result: needle",
      type: "text",
    });
  });

  it("marks successfully loaded servers as active", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer() },
    });
    const select = vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce("○ github");
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);
    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenLastCalledWith("MCP server", [
      `○ ${MCP_MANAGER_SERVER_NAME}`,
      "● github (reconnect)",
    ]);
  });

  it("uses custom UI while loading a selected server when interactive", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer() },
    });
    const host = t.createExtensionHost(mcp);
    let customOpened = false;
    const driver = createCustomUiDriver({
      onComponent: () => {
        customOpened = true;
      },
    });
    const ctx = host.createContext({
      ui: {
        custom: driver.custom,
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    expect(customOpened).toBeTruthy();
    expect(host.getRegisteredTools().has(toGeneratedToolName("github", "search"))).toBeTruthy();
    expect(host.getNotifications()).toContainEqual({
      message: "MCP server github was loaded with 1 tools",
      type: undefined,
    });
  });

  it("shows the manager when the MCP config is empty", async () => {
    await t.writeConfig({ mcpServers: {} });
    const host = t.createExtensionHost(mcp);
    const select = vi.fn<() => Promise<string | undefined>>();
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenCalledWith("MCP server", [`○ ${MCP_MANAGER_SERVER_NAME}`]);
    expect(host.getNotifications()).toStrictEqual([]);
  });

  it("shows the manager when MCP config is invalid", async () => {
    await t.writeConfig({ mcpServers: null });
    const host = t.createExtensionHost(mcp);
    const select = vi.fn<() => Promise<string | undefined>>();
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenCalledWith("MCP server", [`○ ${MCP_MANAGER_SERVER_NAME}`]);
    expect(host.getNotifications()).toContainEqual({
      message: expect.stringContaining("Failed to load MCP config:"),
      type: "error",
    });
  });

  it("persists loaded server state to session entries", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer() },
    });
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      ui: {
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    const mcpEntries = host
      .getAppendedEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "mcp-server-loaded");
    expect(mcpEntries).toStrictEqual([expect.objectContaining({ data: { serverName: "github" } })]);
  });

  it("continues restoring persisted servers after one fails", async () => {
    vi.stubEnv("MCP_TEST_MISSING_COMMAND", undefined);
    await t.writeConfig({
      mcpServers: {
        alpha: { command: envVarRef("MCP_TEST_MISSING_COMMAND"), type: "stdio" },
        beta: fixtureServer(),
      },
    });
    const session = createBranchSession({ chained: true });
    const host = t.createExtensionHost(mcp, session);

    await host.ready;
    await host.emitSessionStart();

    expect(host.getRegisteredTools().has(toGeneratedToolName("beta", "search"))).toBeTruthy();
    expect(host.getActiveTools()).toContain(toGeneratedToolName("beta", "search"));
  });

  it("preserves externally owned manager names during branch reconciliation", async () => {
    await t.writeConfig({ mcpServers: { alpha: fixtureServer() } });
    const host = t.createExtensionHost(mcp, {
      ...createBranchSession(),
      externalTools: ["mcp_list"],
      activeTools: ["read", "mcp_list"],
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toContain("mcp_list");
    host.setLeafId("root");
    await host.emitSessionTree();
    expect(host.getActiveTools()).toContain("mcp_list");
  });

  it("reconciles loaded tools when switching session branches", async () => {
    await t.writeConfig({
      mcpServers: {
        alpha: fixtureServer(),
        beta: fixtureServer(),
      },
    });
    const host = t.createExtensionHost(mcp, createBranchSession());

    await host.emitSessionStart();
    expect(host.getActiveTools()).toContain(toGeneratedToolName("alpha", "search"));

    host.setLeafId("beta-load");
    await host.emitSessionTree();

    expect(host.getActiveTools()).not.toContain(toGeneratedToolName("alpha", "search"));
    expect(host.getActiveTools()).toContain(toGeneratedToolName("beta", "search"));
  });

  it("does not reactivate tools from an obsolete concurrent restore", async () => {
    const alphaFixture = await t.startHttpFixture({ pauseInitialization: true });
    const betaFixture = await t.startHttpFixture();
    await t.writeConfig({
      mcpServers: {
        alpha: { type: "http", url: alphaFixture.url },
        beta: { type: "http", url: betaFixture.url },
      },
    });
    const host = t.createExtensionHost(mcp, createBranchSession());

    const alphaRestore = host.emitSessionStart();
    await alphaFixture.waitForInitialization();
    host.setLeafId("beta-load");
    await host.emitSessionTree();
    alphaFixture.releaseInitialization();
    await alphaRestore;

    expect(host.getActiveTools()).not.toContain(toGeneratedToolName("alpha", "search"));
    expect(host.getActiveTools()).toContain(toGeneratedToolName("beta", "search"));
  });

  it("uses one configuration snapshot for a restore", async () => {
    const alphaFixture = await t.startHttpFixture({ pauseInitialization: true });
    const initialBetaFixture = await t.startHttpFixture();
    const replacementBetaFixture = await t.startHttpFixture();
    await t.writeConfig({
      mcpServers: {
        alpha: { type: "http", url: alphaFixture.url },
        beta: { type: "http", url: initialBetaFixture.url },
      },
    });
    const session = createBranchSession({ chained: true });
    const host = t.createExtensionHost(mcp, session);

    const restore = host.emitSessionStart();
    await alphaFixture.waitForInitialization();
    await t.writeConfig({
      mcpServers: {
        alpha: { type: "http", url: alphaFixture.url },
        beta: { type: "http", url: replacementBetaFixture.url },
      },
    });
    alphaFixture.releaseInitialization();
    await restore;

    expect(initialBetaFixture.getDiscoveryCount()).toBe(1);
    expect(replacementBetaFixture.getDiscoveryCount()).toBe(0);
  });

  it("restores persisted manager tools on session_start without config", async () => {
    const persistedEntry: SessionEntry = {
      customType: "mcp-server-loaded",
      data: {
        serverName: MCP_MANAGER_SERVER_NAME,
      },
      id: "persisted-manager-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom",
    };
    const host = t.createExtensionHost(mcp, {
      entries: [persistedEntry],
      hasUI: false,
      leafId: "persisted-manager-entry",
    });

    await host.emitSessionStart();

    expect(host.getRegisteredTools().has("mcp_list")).toBeTruthy();
  });
});
