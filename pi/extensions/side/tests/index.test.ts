import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const controller = vi.hoisted(() => ({
  closeOnTreeChange: vi.fn<(ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve()
  ),
  dispose: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
  launch: vi.fn<(args: string, ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve()
  ),
  toggle: vi.fn<(ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve()
  ),
}));
const createController = vi.hoisted(() => vi.fn<() => void>());

vi.mock(import("../controller.js"), () => ({
  createSideController: () => {
    createController();
    return controller;
  },
}));

describe("side registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers /side and the focus shortcut, delegating to the controller", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.runCommand("side", "prompt", ctx);
    await host.runShortcut("ctrl+/", ctx);
    await host.emitSessionTree(ctx);
    await host.emitSessionShutdown(ctx);

    expect([...host.getRegisteredCommands().keys()]).toStrictEqual(["side"]);
    expect({
      closeOnTreeChange: controller.closeOnTreeChange.mock.calls,
      dispose: controller.dispose.mock.calls,
      launch: controller.launch.mock.calls,
      toggle: controller.toggle.mock.calls,
    }).toStrictEqual({
      closeOnTreeChange: [[ctx]],
      dispose: [[]],
      launch: [["prompt", ctx]],
      toggle: [[ctx]],
    });
  });

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
