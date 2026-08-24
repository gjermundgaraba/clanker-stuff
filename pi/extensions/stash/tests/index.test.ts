import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const stash = vi.hoisted(() => ({
  commitRestore: vi.fn<(ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve(),
  ),
  dispose: vi.fn<(ctx: ExtensionContext) => Promise<void>>(async () => await Promise.resolve()),
  pop: vi.fn<(ctx: ExtensionContext) => Promise<void>>(async () => await Promise.resolve()),
  prepareRestore: vi.fn<(event: InputEvent, ctx: ExtensionContext) => InputEventResult>(() => ({
    action: "continue",
  })),
  start: vi.fn<(ctx: ExtensionContext) => Promise<void>>(async () => await Promise.resolve()),
  toggle: vi.fn<(ctx: ExtensionContext) => Promise<void>>(async () => await Promise.resolve()),
}));

vi.mock(import("../stash.js"), () => ({
  createStash: () => stash,
}));

describe("stash registration", () => {
  it("registers and delegates stash behavior", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const input = {
      source: "interactive",
      text: "send",
      type: "input",
    } satisfies InputEvent;

    await host.emitSessionStart(ctx);
    await host.runShortcut("ctrl+s", ctx);
    await host.runCommand("pop-stash", "", ctx);
    await host.emitInput(input, ctx);
    await host.emit("turn_start", { turnIndex: 0, type: "turn_start" }, ctx);
    await host.emitSessionShutdown(ctx);

    expect(host.getRegisteredCommands().get("pop-stash")?.description).toBe(
      "Pop the most recent stashed editor text",
    );
    expect({
      commitRestore: stash.commitRestore.mock.calls,
      dispose: stash.dispose.mock.calls,
      pop: stash.pop.mock.calls,
      prepareRestore: stash.prepareRestore.mock.calls,
      start: stash.start.mock.calls,
      toggle: stash.toggle.mock.calls,
    }).toStrictEqual({
      commitRestore: [[ctx]],
      dispose: [[ctx]],
      pop: [[ctx]],
      prepareRestore: [[input, ctx]],
      start: [[ctx]],
      toggle: [[ctx]],
    });
  });
});
