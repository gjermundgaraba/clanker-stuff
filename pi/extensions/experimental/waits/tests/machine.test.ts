import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createActor, createAsyncLogic } from "xstate";
import { restoreActor } from "xstate/persist";

import type { CheckOutcome } from "../check.js";
import { phaseOf, waitMachine } from "../machine.js";
import type { WaitSpec } from "../machine.js";
import { journaledSnapshot } from "./helpers.js";

type Machine = ReturnType<typeof waitMachine.provide>;

const spec: WaitSpec = {
  label: "build",
  condition: "test -f done",
  instruction: "Use the build",
  cwd: "/",
  intervalMs: 1000,
  checkTimeoutMs: 500,
  timeoutMs: 10_000,
};

const failing = { exitCode: 1, timedOut: false } as const;
const passing = { exitCode: 0, timedOut: false } as const;

const scripted = (outcomes: CheckOutcome[]) => {
  const calls: CheckOutcome[] = [];

  const logic = createAsyncLogic({
    run: async () => {
      const next = outcomes[calls.length] ?? failing;
      calls.push(next);

      return next;
    },
  });

  return { calls, machine: waitMachine.provide({ actors: { check: logic } }) };
};

const open = (machine: Machine) =>
  createActor(machine, {
    input: { id: "w_1", spec, openedAt: Date.now() },
  }).start();

const saveAndStop = async (machine: Machine, afterMs: number) => {
  const actor = open(machine);
  await vi.advanceTimersByTimeAsync(afterMs);
  const persisted = actor.getPersistedSnapshot();
  actor.stop();

  return await journaledSnapshot("w_1", persisted);
};

describe("the wait machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks at once, then on the interval, until the condition exits 0", async () => {
    const { calls, machine } = scripted([failing, failing, passing]);
    const actor = open(machine);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(phaseOf(actor.getSnapshot())).toBe("open");

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1001);
    expect(calls).toHaveLength(3);
    expect(phaseOf(actor.getSnapshot())).toBe("satisfied");
    expect(actor.getSnapshot().context.attempts).toBe(3);

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(3);
  });

  it("fires only on delivery", async () => {
    const actor = open(scripted([passing]).machine);
    await vi.advanceTimersByTimeAsync(0);
    expect(phaseOf(actor.getSnapshot())).toBe("satisfied");

    actor.send({ type: "wait.delivered" });
    expect(phaseOf(actor.getSnapshot())).toBe("fired");
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("expires at the deadline while open, but not once satisfied", async () => {
    const expiring = open(scripted([]).machine);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(phaseOf(expiring.getSnapshot())).toBe("expired");

    const satisfied = open(scripted([passing]).machine);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(phaseOf(satisfied.getSnapshot())).toBe("satisfied");
  });

  it("cancels while open or satisfied", async () => {
    const opened = open(scripted([]).machine);
    opened.send({ type: "wait.cancel" });
    expect(phaseOf(opened.getSnapshot())).toBe("cancelled");

    const satisfied = open(scripted([passing]).machine);
    await vi.advanceTimersByTimeAsync(0);
    satisfied.send({ type: "wait.cancel" });
    expect(phaseOf(satisfied.getSnapshot())).toBe("cancelled");
  });

  it("counts a check that errors as a failed attempt", async () => {
    const machine = waitMachine.provide({
      actors: {
        check: createAsyncLogic({
          run: async (): Promise<CheckOutcome> => {
            throw new Error("spawn failed");
          },
        }),
      },
    });

    const actor = open(machine);
    await vi.advanceTimersByTimeAsync(0);

    expect(actor.getSnapshot().value).toStrictEqual({ open: "waiting" });
    expect(actor.getSnapshot().context.lastCheck).toStrictEqual({
      exitCode: null,
      timedOut: false,
    });
  });
});

describe("a restored wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks again at once, keeping the deadline it was opened with", async () => {
    const stored = await saveAndStop(scripted([failing]).machine, 2500);
    await vi.advanceTimersByTimeAsync(4000);

    const after = scripted([]);
    const restored = restoreActor(after.machine, stored).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(after.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3499);
    expect(phaseOf(restored.getSnapshot())).toBe("open");
    await vi.advanceTimersByTimeAsync(1);
    expect(phaseOf(restored.getSnapshot())).toBe("expired");
  });

  it("expires at once when the deadline passed while it was stopped", async () => {
    const stored = await saveAndStop(scripted([failing]).machine, 1000);
    await vi.advanceTimersByTimeAsync(60_000);

    const after = scripted([passing]);
    const restored = restoreActor(after.machine, stored).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(phaseOf(restored.getSnapshot())).toBe("expired");
  });
});
