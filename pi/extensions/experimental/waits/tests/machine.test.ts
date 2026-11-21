import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createActor, createAsyncLogic } from "xstate";

import type { CheckResult } from "../check.js";
import { waitMachine } from "../machine.js";
import type { WaitSpec } from "../spec.js";

const spec: WaitSpec = {
  label: "build",
  condition: "test -f done",
  instruction: "Use the build",
  cwd: "/",
  intervalSeconds: 1,
  checkTimeoutSeconds: 1,
};

const scripted = (results: Array<CheckResult | Error>) => {
  let calls = 0;

  const check = createAsyncLogic({
    run: async (): Promise<CheckResult> => {
      const next = results[calls] ?? 1;
      calls += 1;

      if (next instanceof Error) {
        throw next;
      }

      return next;
    },
  });

  const actor = createActor(waitMachine.provide({ actors: { check } }), {
    input: { id: "w_1", spec, remainingMs: 10_000 },
  });

  return { actor, calls: () => calls };
};

describe("the wait machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks at once, then every interval, until the condition exits 0", async () => {
    const { actor, calls } = scripted([1, 2, 0]);
    actor.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    expect(actor.getSnapshot().context.lastResult).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1001);
    expect(calls()).toBe(3);
    expect(actor.getSnapshot().status).toBe("done");
    expect(actor.getSnapshot().matches("satisfied")).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls()).toBe(3);
  });

  it("expires when its remaining time runs out, keeping the last result", async () => {
    const { actor } = scripted(["timeout"]);
    actor.start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(actor.getSnapshot().status).toBe("active");

    await vi.advanceTimersByTimeAsync(1);
    expect(actor.getSnapshot().matches("expired")).toBe(true);
    expect(actor.getSnapshot().context.lastResult).toBe(1);
  });

  it("expires without checking when no time remains", async () => {
    let calls = 0;

    const check = createAsyncLogic({
      run: async (): Promise<CheckResult> => {
        calls += 1;

        return 0;
      },
    });

    const actor = createActor(waitMachine.provide({ actors: { check } }), {
      input: { id: "w_1", spec, remainingMs: 0 },
    }).start();

    await vi.advanceTimersByTimeAsync(0);

    expect(actor.getSnapshot().matches("expired")).toBe(true);
    expect(calls).toBe(0);
  });

  it("records a check that cannot run and checks again", async () => {
    const { actor, calls } = scripted([new Error("spawn failed"), 0]);
    actor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(actor.getSnapshot().value).toStrictEqual({ open: "waiting" });
    expect(actor.getSnapshot().context.lastResult).toBe("error");

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls()).toBe(2);
    expect(actor.getSnapshot().matches("satisfied")).toBe(true);
  });
});
