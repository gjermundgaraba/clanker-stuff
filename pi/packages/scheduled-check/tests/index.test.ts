import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createScheduledCheck } from "../index.js";

describe("scheduled check", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("coalesces work without postponing the first deadline", () => {
    const callback = vi.fn<() => void>();
    const check = createScheduledCheck(callback);

    check.request(100);
    vi.advanceTimersByTime(50);
    check.request(100);
    vi.advanceTimersByTime(49);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("replaces a readiness recheck with an earlier deadline", () => {
    const callback = vi.fn<() => void>();
    const check = createScheduledCheck(callback);

    check.request(1000);
    vi.advanceTimersByTime(50);
    check.request(100);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("allows the callback to request another check", () => {
    const callback = vi.fn<() => void>();
    const check = createScheduledCheck(callback);

    callback.mockImplementation(() => {
      if (callback.mock.calls.length === 1) {
        check.request(10);
      }
    });

    check.request(100);
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("clears pending work without disabling future requests", () => {
    const callback = vi.fn<() => void>();
    const check = createScheduledCheck(callback);

    check.request(100);
    check.clear();
    check.clear();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    check.request(10);
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledOnce();
  });
});
