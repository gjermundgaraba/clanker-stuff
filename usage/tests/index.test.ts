import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const controller = vi.hoisted(() => ({
  dispose: vi.fn<() => void>(),
  runCommand:
    vi.fn<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(),
  start: vi.fn<(ctx: ExtensionContext) => void>(),
  trackModel: vi.fn<(ctx: ExtensionContext, model: unknown) => void>(),
}));

vi.mock(import("../controller.js"), () => ({
  createUsageController: () => controller,
}));

describe("usage registration", () => {
  it("registers /usage and delegates lifecycle to the controller", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const model = { provider: "openai-codex" };

    await host.runCommand("usage", "refresh", ctx);
    await host.emitSessionStart(ctx);
    await host.emit("model_select", { model, type: "model_select" }, ctx);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await host.emitSessionShutdown(ctx);

    expect(host.getRegisteredCommands().get("usage")).toMatchObject({
      description: "Show subscription usage for supported providers",
    });
    expect({
      dispose: controller.dispose.mock.calls.length,
      runCommand: controller.runCommand.mock.calls,
      start: controller.start.mock.calls,
      trackModel: controller.trackModel.mock.calls,
    }).toStrictEqual({
      dispose: 1,
      runCommand: [["refresh", ctx]],
      start: [[ctx]],
      trackModel: [
        [ctx, model],
        [ctx, ctx.model],
      ],
    });
  });
});
