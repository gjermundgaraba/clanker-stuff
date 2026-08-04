import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const selection = vi.hoisted(() => ({
  open: vi.fn<(ctx: ExtensionCommandContext) => Promise<void>>(() =>
    Promise.resolve()
  ),
  restore: vi.fn<(ctx: ExtensionContext) => void>(),
  start: vi.fn<(ctx: ExtensionContext) => void>(),
}));

vi.mock(import("../selection.js"), () => ({
  createToolSelection: () => selection,
}));

describe("tool-picker registration", () => {
  it("registers and delegates the tool picker", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.runCommand("tools", "", ctx);
    await host.emitSessionStart(ctx);
    await host.emitSessionTree(ctx);

    expect(host.getRegisteredCommands().get("tools")?.description).toBe(
      "Enable/disable tools"
    );
    expect(selection.open).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(selection.start).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(selection.restore).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});
