import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const TIMER_INTERVAL_MS = 100;

const setup = () => {
  const host = createExtensionHost(extension);
  const ctx = host.createContext();
  return { ctx, host };
};

describe("timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows 0.0s immediately on agent_start", async () => {
    const { host, ctx } = setup();
    await host.emit("agent_start", {}, ctx);
    expect(host.getStatus("timer")).toBe("0.0s");
  });

  it("updates the status while the agent is running", async () => {
    const { host, ctx } = setup();
    await host.emit("agent_start", {}, ctx);

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 4);
    expect(host.getStatus("timer")).toBe("0.4s");

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 6);
    expect(host.getStatus("timer")).toBe("1.0s");
  });

  it("stops updating and shows final elapsed on agent_settled", async () => {
    const { host, ctx } = setup();
    await host.emit("agent_start", {}, ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 12);
    expect(host.getStatus("timer")).toBe("1.2s");

    await host.emit("agent_settled", {}, ctx);
    expect(host.getStatus("timer")).toBe("1.2s");

    const callCountAfterEnd = vi.mocked(ctx.ui.setStatus).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(
      callCountAfterEnd
    );
  });

  it("formats times over 60 seconds as mm:ss", async () => {
    const { host, ctx } = setup();
    await host.emit("agent_start", {}, ctx);

    vi.advanceTimersByTime(65_000);
    expect(host.getStatus("timer")).toBe("1:05");

    vi.advanceTimersByTime(60_000);
    expect(host.getStatus("timer")).toBe("2:05");
  });

  it("keeps one timer across repeated agent_start events", async () => {
    const { host, ctx } = setup();
    await host.emit("agent_start", {}, ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 20);
    await host.emit("agent_start", {}, ctx);
    expect(host.getStatus("timer")).toBe("2.0s");

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 4);
    expect(host.getStatus("timer")).toBe("2.4s");

    await host.emit("agent_settled", {}, ctx);
    await host.emit("agent_start", {}, ctx);
    expect(host.getStatus("timer")).toBe("0.0s");
  });

  it("clears the timer on session_shutdown", async () => {
    const { host, ctx } = setup();
    await host.emit("agent_start", {}, ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 5);
    await host.emitSessionShutdown(ctx);

    const callCountAfterShutdown = vi.mocked(ctx.ui.setStatus).mock.calls
      .length;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(
      callCountAfterShutdown
    );
  });
});
