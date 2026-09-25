import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createTiming, formatElapsed } from "../timing.js";

afterEach(() => vi.useRealTimers());

describe("active timing", () => {
  it("uses monotonic time even if the wall clock jumps and coalesces duplicate pauses/resumes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const clock = createTiming(false);
    vi.advanceTimersByTime(1000);
    clock.pause();
    clock.pause();
    vi.setSystemTime(1);
    vi.advanceTimersByTime(2000);
    clock.resume();
    clock.resume();
    vi.advanceTimersByTime(500);
    expect(clock.read()).toEqual({ startedAt: 1000, activeMs: 1500, wallMs: 3500 });
  });

  it.each([
    [0, "0.0s", "0s"],
    [12_345, "12.3s", "12s"],
    [59_949, "59.9s", "59s"],
    [59_950, "1:00", "59s"],
    [59_999, "1:00", "59s"],
    [60_000, "1:00", "1:00"],
    [119_950, "2:00", "1:59"],
    [125_000, "2:05", "2:05"],
  ] as const)("formats %i ms", (ms, precise, live) => {
    expect(formatElapsed(ms)).toBe(precise);
    expect(formatElapsed(ms, "seconds")).toBe(live);
  });
});
