import { describe, expect, it, vi } from "vitest";

import mcp from "../index.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

describe("mcp server pool", () => {
  const t = setupMcpTest();

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
