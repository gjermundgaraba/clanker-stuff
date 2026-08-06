import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const footerHost = vi.hoisted(() => ({
  refresh: vi.fn<(ctx: ExtensionContext) => void>(),
  refreshTotals: vi.fn<(ctx: ExtensionContext) => void>(),
  runCommand: vi.fn<(args: string, ctx: ExtensionContext) => Promise<void>>(),
  shutdown: vi.fn<() => void>(),
  start: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
  turnEnd: vi.fn<(ctx: ExtensionContext) => void>(),
}));

vi.mock(import("../host.js"), () => ({
  createFooterHost: () => footerHost,
}));

describe("footer registration", () => {
  it("registers /footer and delegates lifecycle to the host", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.runCommand("footer", "doctor", ctx);
    await host.emitSessionStart(ctx);
    await host.emit("model_select", { type: "model_select" }, ctx);
    await host.emit(
      "thinking_level_select",
      { type: "thinking_level_select" },
      ctx
    );
    await host.emit("message_end", { type: "message_end" }, ctx);
    await host.emitTurnEnd(undefined, ctx);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await host.emit("session_tree", { type: "session_tree" }, ctx);
    await host.emit("session_compact", { type: "session_compact" }, ctx);
    await host.emit(
      "session_info_changed",
      { type: "session_info_changed" },
      ctx
    );
    await host.emitSessionShutdown(ctx);

    expect(host.getRegisteredCommands().get("footer")).toMatchObject({
      description: "Configure or inspect the cooperative footer",
    });
    expect({
      refresh: footerHost.refresh.mock.calls,
      refreshTotals: footerHost.refreshTotals.mock.calls,
      runCommand: footerHost.runCommand.mock.calls,
      shutdown: footerHost.shutdown.mock.calls.length,
      start: footerHost.start.mock.calls,
      turnEnd: footerHost.turnEnd.mock.calls,
    }).toStrictEqual({
      refresh: [[ctx], [ctx], [ctx]],
      refreshTotals: [[ctx], [ctx], [ctx], [ctx]],
      runCommand: [["doctor", ctx]],
      shutdown: 1,
      start: [[ctx]],
      turnEnd: [[ctx]],
    });
  });
});
