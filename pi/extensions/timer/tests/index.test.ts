import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

describe("timer lifecycle wiring", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([true, false, "true", null, undefined])(
    "validates async prompt events at the bus boundary (%s)",
    async (active) => {
      const host = createExtensionHost(extension);
      const ctx = host.createContext();
      await host.emit("agent_start", {}, ctx);
      host.events.emit("clanker:async-prompt", { active });
      await host.emit("ui_prompt_start", {}, ctx);
      vi.advanceTimersByTime(1000);
      await host.emit("ui_prompt_end", {}, ctx);
      await host.emit("agent_settled", {}, ctx);
      expect(host.getStatus("timer")).toContain(active === true ? "1.0s" : "0.0s");
      await host.emitSessionShutdown(ctx);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("resumes timed work after prompts and stops all timers on shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    await host.emit("agent_start", {}, ctx);
    vi.advanceTimersByTime(500);
    await host.emit("ui_prompt_start", {}, ctx);
    vi.advanceTimersByTime(5000);
    await host.emit("ui_prompt_end", {}, ctx);
    vi.advanceTimersByTime(500);
    await host.emit("agent_settled", {}, ctx);
    expect(host.getStatus("timer")).toContain("1.0s");
    expect(vi.getTimerCount()).toBe(0);
    await host.emit("agent_start", {}, ctx);
    expect(vi.getTimerCount()).toBe(1);
    await host.emitSessionShutdown(ctx);
    expect(vi.getTimerCount()).toBe(0);
  });
});
