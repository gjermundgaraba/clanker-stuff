import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

const orb = vi.hoisted(() => ({
  onAgentSettled: vi.fn<() => void>(),
  onAgentStart: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
  onSessionShutdown: vi.fn<() => Promise<void>>(),
  setup: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
  startManual: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
  status: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
  stopManual: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
}));

vi.mock(import("../lifecycle.js"), () => ({
  createOrbLifecycle: () => orb,
}));

describe("thinking-orb registration", () => {
  const host = createExtensionHost(extension);

  it("registers the orb commands", () => {
    expect([...host.getRegisteredCommands().keys()].toSorted()).toStrictEqual([
      "orb-setup",
      "orb-start",
      "orb-status",
      "orb-stop",
    ]);
  });

  it("wires agent events to the lifecycle", async () => {
    const ctx = host.createContext();

    await host.emit("agent_start", {}, ctx);
    expect(orb.onAgentStart).toHaveBeenCalledExactlyOnceWith(ctx);

    await host.emit("agent_settled", {}, ctx);
    expect(orb.onAgentSettled).toHaveBeenCalledOnce();

    await host.emitSessionShutdown(ctx);
    expect(orb.onSessionShutdown).toHaveBeenCalledOnce();
  });

  it("delegates commands to the lifecycle", async () => {
    const ctx = host.createContext();

    await host.runCommand("orb-start", "", ctx);
    expect(orb.startManual).toHaveBeenCalledExactlyOnceWith(ctx);

    await host.runCommand("orb-stop", "", ctx);
    expect(orb.stopManual).toHaveBeenCalledExactlyOnceWith(ctx);

    await host.runCommand("orb-status", "", ctx);
    expect(orb.status).toHaveBeenCalledExactlyOnceWith(ctx);

    await host.runCommand("orb-setup", "", ctx);
    expect(orb.setup).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});
