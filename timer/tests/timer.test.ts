import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import { createTimer } from "../timer.js";

const TIMER_INTERVAL_MS = 100;

const setup = () => {
  const host = createExtensionHost(() => {});
  const ctx = host.createContext();
  const timer = createTimer();
  return { ctx, host, timer };
};

describe("timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the status while the agent is running", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 4);
    expect(host.getStatus("timer")).toBe("0.4s");

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 6);
    expect(host.getStatus("timer")).toBe("1.0s");
  });

  it("stops updating and shows final elapsed on agent_settled", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 12);
    timer.stop(ctx);
    expect(host.getStatus("timer")).toBe("1.2s");

    const callCountAfterEnd = vi.mocked(ctx.ui.setStatus).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(
      callCountAfterEnd
    );
  });

  it("formats times over 60 seconds as mm:ss", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);

    vi.advanceTimersByTime(65_000);
    expect(host.getStatus("timer")).toBe("1:05");

    vi.advanceTimersByTime(60_000);
    expect(host.getStatus("timer")).toBe("2:05");
  });

  it("keeps one timer across repeated agent_start events", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 20);
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 4);
    expect(host.getStatus("timer")).toBe("2.4s");

    timer.stop(ctx);
    timer.start(ctx);
    expect(host.getStatus("timer")).toBe("0.0s");
  });

  it("clears the timer on session_shutdown", () => {
    const { ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 5);
    timer.dispose();

    const callCountAfterShutdown = vi.mocked(ctx.ui.setStatus).mock.calls
      .length;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(
      callCountAfterShutdown
    );
  });
});
