import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { cleanupOf, outcomeOf, resultOf, taskMachine } from "../phase.js";
import type { Ended, TaskPhase, TaskPhaseEvent } from "../phase.js";

const send = (phase: TaskPhase, event: TaskPhaseEvent): TaskPhase =>
  taskMachine.transition(phase, event)[0];

const running = taskMachine.initialState;

describe("taskMachine", () => {
  it("the first outcome wins and a later cancel or result is rejected", () => {
    const reaping = send(running, {
      type: "task.end",
      outcome: "timeout",
      at: 10,
    });

    expect(reaping).toMatchObject({
      value: "reaping",
      context: { ended: { outcome: "timeout", endedAt: 10 } },
    });

    for (const late of [
      { type: "task.end", outcome: "process_error", at: 20 },
      { type: "task.result", data: { late: true }, at: 20 },
      { type: "task.stop", at: 20 },
    ] as const) {
      expect(send(reaping, late)).toBe(reaping);
    }

    const clean = send(reaping, { type: "cleanup.done", verdict: "clean" });

    expect(clean.value).toBe("clean");
    expect(send(clean, { type: "task.stop", at: 30 })).toBe(clean);
    expect(
      send(clean, { type: "task.end", outcome: "cancelled", at: 30 })
    ).toBe(clean);
    expect(outcomeOf(clean)).toBe("timeout");
    expect(resultOf(clean)).toBeUndefined();
  });

  it("a failed cleanup returns to reaping on stop and keeps its outcome", () => {
    const reaping = send(running, {
      type: "task.result",
      data: { conclusion: "failure" },
      at: 10,
    });

    const failed = send(reaping, { type: "cleanup.done", verdict: "failed" });

    expect(failed.value).toBe("cleanupFailed");
    expect(
      send(failed, { type: "task.end", outcome: "cancelled", at: 20 })
    ).toBe(failed);

    const retry = send(failed, { type: "task.stop", at: 20 });

    expect(retry).toMatchObject({
      value: "reaping",
      context: {
        ended: {
          outcome: "result",
          endedAt: 10,
          result: { conclusion: "failure" },
        },
      },
    });
    expect(send(retry, { type: "cleanup.done", verdict: "clean" }).value).toBe(
      "clean"
    );
  });

  it("cleanupOf reports pending while running and reaping, and outcomeOf hides nothing it should show", () => {
    expect(send(running, { type: "cleanup.done", verdict: "clean" })).toBe(
      running
    );

    const stopped = send(running, { type: "task.stop", at: 10 });
    const failed = send(stopped, { type: "cleanup.done", verdict: "failed" });
    const clean = send(stopped, { type: "cleanup.done", verdict: "clean" });

    expect(
      [running, stopped, failed, clean].map((phase) => [
        phase.value,
        cleanupOf(phase),
        outcomeOf(phase),
      ])
    ).toStrictEqual([
      ["running", "pending", undefined],
      ["reaping", "pending", "cancelled"],
      ["cleanupFailed", "failed", "cancelled"],
      ["clean", "clean", "cancelled"],
    ]);

    const phase: TaskPhase = clean;

    if (phase.value === "running") {
      expectTypeOf(phase.context.ended).toEqualTypeOf<null>();
    } else {
      expectTypeOf(phase.context.ended).toEqualTypeOf<Ended>();
    }
  });
});
