import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import mcp from "../index.js";
import { MCP_MANAGER_SERVER_NAME } from "../manager.js";
import { createCustomStub, fixtureServer, setupMcpTest } from "./helpers.js";

const createBranchSession = () => {
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
        parentId: "root",
        timestamp,
        type: "custom",
      },
    ] satisfies SessionEntry[],
    hasUI: false,
    leafId: "alpha-load",
  };
};

describe("mcp loader", () => {
  const t = setupMcpTest();

  it("does not load servers on session_start without persisted entries", async () => {
    await t.writeConfig({ invalid: true });
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
    expect(host.getRegisteredTools().has("mcp_project__search")).toBeTruthy();
  });

  it("connects the selected server and registers its tools as active", async () => {
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
    const result = await host.runTool("mcp_github__search", {
      query: "needle",
    });

    expect(host.getActiveTools()).toContain("mcp_github__search");
    expect(host.getRegisteredTools().has("mcp_github__search")).toBeTruthy();
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
    const select = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("○ github");
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);
    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenLastCalledWith("MCP server", [
      `○ ${MCP_MANAGER_SERVER_NAME}`,
      "● github (active)",
    ]);
  });

  it("uses custom UI while loading a selected server when interactive", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer() },
    });
    const host = t.createExtensionHost(mcp);
    const custom = createCustomStub();
    const ctx = host.createContext({
      ui: {
        custom,
        select: vi.fn<() => Promise<string>>(async () => "○ github"),
      },
    });

    await host.runCommand("mcp", "", ctx);

    expect(custom).toHaveBeenCalledOnce();
    expect(host.getRegisteredTools().has("mcp_github__search")).toBeTruthy();
  });

  it("shows the manager when the MCP config is empty", async () => {
    await t.writeConfig({ mcpServers: {} });
    const host = t.createExtensionHost(mcp);
    const select = vi.fn<() => Promise<string | undefined>>();
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenCalledWith("MCP server", [
      `○ ${MCP_MANAGER_SERVER_NAME}`,
    ]);
    expect(host.getNotifications()).toStrictEqual([]);
  });

  it("shows the manager when MCP config is invalid", async () => {
    await t.writeConfig({ invalid: true });
    const host = t.createExtensionHost(mcp);
    const select = vi.fn<() => Promise<string | undefined>>();
    const ctx = host.createContext({ ui: { select } });

    await host.runCommand("mcp", "", ctx);

    expect(select).toHaveBeenCalledWith("MCP server", [
      `○ ${MCP_MANAGER_SERVER_NAME}`,
    ]);
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
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "mcp-server-loaded"
      );
    expect(mcpEntries).toHaveLength(1);
    const { data } = mcpEntries[0] as { data: unknown };
    expect(data).toStrictEqual({
      serverName: "github",
    });
  });

  it("auto-reconnects persisted servers on session_start", async () => {
    await t.writeConfig({
      mcpServers: { github: fixtureServer() },
    });

    const persistedEntry: SessionEntry = {
      customType: "mcp-server-loaded",
      data: {
        serverName: "github",
      },
      id: "persisted-load-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom",
    };

    const host = t.createExtensionHost(mcp, {
      entries: [persistedEntry],
      hasUI: false,
      leafId: "persisted-load-entry",
    });

    await host.ready;
    await host.emitSessionStart();

    expect(host.getRegisteredTools().has("mcp_github__search")).toBeTruthy();
    expect(host.getActiveTools()).toContain("mcp_github__search");
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
    expect(host.getActiveTools()).toContain("mcp_alpha__search");

    host.setLeafId("beta-load");
    await host.emitSessionTree();

    expect(host.getActiveTools()).not.toContain("mcp_alpha__search");
    expect(host.getActiveTools()).toContain("mcp_beta__search");
  });

  it("does not reactivate tools from an obsolete concurrent restore", async () => {
    const alphaFixture = await t.startHttpFixture(false, false, true);
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

    expect(host.getActiveTools()).not.toContain("mcp_alpha__search");
    expect(host.getActiveTools()).toContain("mcp_beta__search");
  });

  it("uses one configuration snapshot for a restore", async () => {
    const alphaFixture = await t.startHttpFixture(false, false, true);
    const initialBetaFixture = await t.startHttpFixture();
    const replacementBetaFixture = await t.startHttpFixture();
    await t.writeConfig({
      mcpServers: {
        alpha: { type: "http", url: alphaFixture.url },
        beta: { type: "http", url: initialBetaFixture.url },
      },
    });
    const session = createBranchSession();
    const betaEntry = session.entries.at(-1);
    if (!betaEntry) {
      throw new Error("missing beta fixture entry");
    }
    betaEntry.parentId = "alpha-load";
    session.leafId = "beta-load";
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

    expect(initialBetaFixture.getInitializationCount()).toBe(1);
    expect(replacementBetaFixture.getInitializationCount()).toBe(0);
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

    expect(
      host.getRegisteredTools().has("mcp_mcp_manager__list_mcps")
    ).toBeTruthy();
  });
});
