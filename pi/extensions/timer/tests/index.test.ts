import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const timer = vi.hoisted(() => ({
  dispose: vi.fn<() => void>(),
  start: vi.fn<(ctx: ExtensionContext) => void>(),
  stop: vi.fn<(ctx: ExtensionContext) => void>(),
}));

vi.mock(import("../timer.js"), () => ({ createTimer: () => timer }));

describe("timer registration", () => {
  it("wires the timer lifecycle", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.emit("agent_start", {}, ctx);
    await host.emit("agent_settled", {}, ctx);
    await host.emitSessionShutdown(ctx);

    expect(timer.start).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(timer.stop).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(timer.dispose).toHaveBeenCalledOnce();
  });
});
