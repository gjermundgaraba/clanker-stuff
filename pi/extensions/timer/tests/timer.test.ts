import { BREATHING_DOT_INTERVAL_MS as TIMER_INTERVAL_MS } from "@clanker-stuff/pi-motion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createTimer } from "../timer.js";

const START = new Date(2026, 7, 28, 14, 30, 0);

const clockAt = (msAfterStart: number) =>
  new Date(START.getTime() + msAfterStart).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

const setup = () => {
  const host = createExtensionHost(() => {});
  const ctx = host.createContext();
  const timer = createTimer();
  return { ctx, host, timer };
};

describe("timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the status while the agent is running", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 4);
    expect(host.getStatus("timer")).toBe(`● 0.5s · ${clockAt(0)}`);

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 6);
    expect(host.getStatus("timer")).toBe(`· 1.3s · ${clockAt(0)}`);
  });

  it("does no status work outside TUI mode", () => {
    const { ctx, timer } = setup();
    const printContext = {
      ...ctx,
      mode: "json" as const,
    };

    timer.start(printContext);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 10);

    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("stops updating and shows final elapsed on agent_settled", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 12);
    timer.stop(ctx);
    expect(host.getStatus("timer")).toBe(`● 1.6s · ${clockAt(TIMER_INTERVAL_MS * 12)}`);

    const callCountAfterEnd = vi.mocked(ctx.ui.setStatus).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(callCountAfterEnd);
  });

  it("formats times over 60 seconds as mm:ss", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 500);
    expect(host.getStatus("timer")).toBe(`• 1:05 · ${clockAt(0)}`);

    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 462);
    expect(host.getStatus("timer")).toBe(`• 2:05 · ${clockAt(0)}`);

    timer.stop(ctx);
    expect(host.getStatus("timer")).toBe(`● 2:05 · ${clockAt(TIMER_INTERVAL_MS * 962)}`);
  });

  it("keeps one timer across repeated agent_start events", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 20);
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 4);
    expect(host.getStatus("timer")).toBe(`· 3.1s · ${clockAt(0)}`);

    timer.stop(ctx);
    timer.start(ctx);
    expect(host.getStatus("timer")).toBe(`· 0.0s · ${clockAt(TIMER_INTERVAL_MS * 24)}`);
  });

  it("excludes time spent waiting in a UI prompt", () => {
    const { host, ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 5);
    timer.pause(ctx);
    vi.advanceTimersByTime(10_000);
    timer.resume(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 5);
    timer.stop(ctx);

    expect(host.getStatus("timer")).toBe(`● 1.3s · ${clockAt(10_000 + TIMER_INTERVAL_MS * 10)}`);
  });

  it("stays paused when a run starts inside a prompt and ignores a late prompt end", () => {
    const { host, ctx, timer } = setup();
    timer.pause(ctx);
    timer.start(ctx);
    vi.advanceTimersByTime(1000);
    timer.stop(ctx);

    expect(host.getStatus("timer")).toBe(`● 0.0s · ${clockAt(1000)}`);
    const callCountAfterEnd = vi.mocked(ctx.ui.setStatus).mock.calls.length;
    timer.resume(ctx);
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(callCountAfterEnd);
  });

  it("clears the timer on session_shutdown", () => {
    const { ctx, timer } = setup();
    timer.start(ctx);
    vi.advanceTimersByTime(TIMER_INTERVAL_MS * 5);
    timer.dispose();

    const callCountAfterShutdown = vi.mocked(ctx.ui.setStatus).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledTimes(callCountAfterShutdown);
  });
});
