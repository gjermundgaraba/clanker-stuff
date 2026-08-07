import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

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

vi.mock(import("../controller.js"), () => ({
  createSideController: () => controller,
}));

describe("side registration", () => {
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
});
