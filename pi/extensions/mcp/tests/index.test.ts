import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import mcp from "../index.js";

const loader = vi.hoisted(() => ({
  dispose: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
  pickAndLoad: vi.fn<(ctx: ExtensionCommandContext) => Promise<void>>(
    async () => await Promise.resolve()
  ),
  restore: vi.fn<(ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve()
  ),
}));
const createLoader = vi.hoisted(() => vi.fn<() => void>());

vi.mock(import("../loader.js"), () => ({
  createMcpLoader: () => {
    createLoader();
    return loader;
  },
}));

describe("mcp registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers /mcp and delegates lifecycle to the loader", async () => {
    const host = createExtensionHost(mcp);
    const ctx = host.createContext();

    await host.runCommand("mcp", "", ctx);
    await host.emitSessionStart(ctx);
    await host.emitSessionShutdown(ctx);

    expect(host.getRegisteredCommands().get("mcp")).toMatchObject({
      description: "Load MCP server tools",
    });
    expect({
      dispose: loader.dispose.mock.calls.length,
      pickAndLoad: loader.pickAndLoad.mock.calls,
      restore: loader.restore.mock.calls,
    }).toStrictEqual({
      dispose: 1,
      pickAndLoad: [[ctx]],
      restore: [[ctx]],
    });
  });

  it("does not open the picker after shutdown wins the first-load race", async () => {
    const host = createExtensionHost(mcp);
    const ctx = host.createContext();

    const command = host.runCommand("mcp", "", ctx);
    await host.emitSessionShutdown(ctx);
    await command;

    expect(createLoader).not.toHaveBeenCalled();
    expect(loader.dispose).not.toHaveBeenCalled();
    expect(loader.pickAndLoad).not.toHaveBeenCalled();
  });
});
