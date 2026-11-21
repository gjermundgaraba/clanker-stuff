import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { WakeGate } from "../gate.js";

const setup = () => {
  const state = { idle: true, pending: false, work: true, delivered: 0 };

  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
  };

  const gate = new WakeGate({
    context: () => ctx,
    hasWork: () => state.work,
    deliver: () => {
      state.delivered += 1;
      state.work = false;
    },
  });

  return { gate, state };
};

describe("WakeGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers soon after a request while Pi is idle", async () => {
    const { gate, state } = setup();
    gate.request();
    await vi.advanceTimersByTimeAsync(100);

    expect(state.delivered).toBe(1);
  });

  it("holds the wake while the agent runs and delivers on settle", async () => {
    const { gate, state } = setup();
    state.idle = false;
    gate.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(state.delivered).toBe(0);

    state.idle = true;
    gate.settled();
    expect(state.delivered).toBe(1);
  });

  it("rechecks on its own after a dialog or compaction, which end without a settle", async () => {
    const { gate, state } = setup();
    gate.setPrompting(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.delivered).toBe(0);

    gate.setPrompting(false);
    gate.setCompacting(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.delivered).toBe(0);

    gate.setCompacting(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.delivered).toBe(1);
  });

  it("waits for queued messages to drain", async () => {
    const { gate, state } = setup();
    state.pending = true;
    gate.request();
    await vi.advanceTimersByTimeAsync(1100);
    expect(state.delivered).toBe(0);

    state.pending = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.delivered).toBe(1);
  });
});
