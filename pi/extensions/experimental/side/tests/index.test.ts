import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

const controller = vi.hoisted(() => ({
  closeOnTreeChange: vi.fn<(ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve(),
  ),
  dispose: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
  launch: vi.fn<(args: string, ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve(),
  ),
  toggle: vi.fn<(ctx: ExtensionContext) => Promise<void>>(async () => await Promise.resolve()),
}));

const createController = vi.hoisted(() => vi.fn<() => void>());

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the real dynamic-import/shutdown race; injecting an already-loaded controller would bypass it.
vi.mock(import("../controller.js"), () => ({
  createSideController: () => {
    createController();

    return controller;
  },
}));

describe("side registration", () => {
  it("does not launch after shutdown wins the first-load race", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    const command = host.runCommand("side", "prompt", ctx);
    await host.emitSessionShutdown(ctx);
    await command;

    expect(createController).not.toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();
    expect(controller.launch).not.toHaveBeenCalled();
  });
});
