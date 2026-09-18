import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

const controller = vi.hoisted(() => ({
  dispose: vi.fn<() => void>(),
  runCommand: vi.fn<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(),
  start: vi.fn<(ctx: ExtensionContext) => void>(),
  trackModel:
    vi.fn<(ctx: ExtensionContext, model: { provider?: string } | null | undefined) => void>(),
}));

const createController = vi.hoisted(() => vi.fn<() => void>());

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the real lazy import lifecycle with constructor failure and shutdown-during-load; injecting an already-created controller would bypass those paths.
vi.mock(import("../controller.js"), () => ({
  createUsageController: () => {
    createController();

    return controller;
  },
}));

describe("usage registration", () => {
  it("does not finish loading after shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    const command = host.runCommand("usage", "", ctx);
    await host.emitSessionShutdown(ctx);
    await command;

    expect(createController).not.toHaveBeenCalled();
  });

  it("reports background startup failures", async () => {
    createController.mockImplementationOnce(() => {
      throw new Error("load failed");
    });
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await vi.waitFor(() => {
      expect(host.getNotifications()).toContainEqual({
        message: "Usage failed to initialize: load failed",
        type: "error",
      });
    });
    await host.runCommand("usage", "", ctx);
    await host.emitSessionShutdown(ctx);

    expect(createController).toHaveBeenCalledTimes(2);
    expect(controller.runCommand).toHaveBeenCalledOnce();
  });
});
