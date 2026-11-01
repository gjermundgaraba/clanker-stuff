import type { JsonValue } from "@earendil-works/pi-ai";
import { setup, types } from "xstate/fsm";

import type { Outcome, TaskSummary } from "./output.js";

export type Ended = { endedAt: number } & (
  | { outcome: Exclude<Outcome, "result"> }
  | { outcome: "result"; result: JsonValue }
);

const endedContext = types<{ ended: Ended }>();

export const taskMachine = setup({
  schemas: {
    events: {
      "task.end": types<{ outcome: Exclude<Outcome, "result">; at: number }>(),
      "task.result": types<{ data: JsonValue; at: number }>(),
      "task.stop": types<{ at: number }>(),
      "cleanup.done": types<{ verdict: "clean" | "failed" }>(),
    },
  },
  states: {
    running: { schemas: { context: types<{ ended: null }>() } },
    reaping: { schemas: { context: endedContext } },
    clean: { schemas: { context: endedContext } },
    cleanupFailed: { schemas: { context: endedContext } },
  },
}).createFSM({
  initial: "running",
  context: { ended: null },
  states: {
    running: {
      on: {
        "task.end": ({ event }) => ({
          target: "reaping",
          context: { ended: { outcome: event.outcome, endedAt: event.at } },
        }),
        "task.result": ({ event }) => ({
          target: "reaping",
          context: {
            ended: { outcome: "result", endedAt: event.at, result: event.data },
          },
        }),
        "task.stop": ({ event }) => ({
          target: "reaping",
          context: { ended: { outcome: "cancelled", endedAt: event.at } },
        }),
      },
    },
    reaping: {
      on: {
        "cleanup.done": ({ event }) => ({
          target: event.verdict === "clean" ? "clean" : "cleanupFailed",
        }),
      },
    },
    clean: {},
    cleanupFailed: {
      on: { "task.stop": "reaping" },
    },
  },
});

export type TaskPhase = typeof taskMachine.initialState;

export type TaskPhaseEvent = Parameters<typeof taskMachine.transition>[1];

export const outcomeOf = (phase: TaskPhase): Outcome | undefined =>
  phase.context.ended?.outcome;

export const resultOf = (phase: TaskPhase): JsonValue | undefined => {
  const { ended } = phase.context;

  return ended?.outcome === "result" ? ended.result : undefined;
};

const CLEANUP = {
  running: "pending",
  reaping: "pending",
  clean: "clean",
  cleanupFailed: "failed",
} as const satisfies Record<TaskPhase["value"], TaskSummary["cleanup"]>;

export const cleanupOf = (phase: TaskPhase): TaskSummary["cleanup"] =>
  CLEANUP[phase.value];
