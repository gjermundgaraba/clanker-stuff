import { setup, types } from "xstate/fsm";

import { bound, MAX_STATUS_TEXT } from "./protocol.js";
import type { AgentNode } from "./protocol.js";
import type { ChildRuntime, ChildTurnOutcome } from "./runtime.js";

export interface Turn {
  readonly retired: PromiseWithResolvers<undefined>;
  readonly runtime: ChildRuntime;
}

type Ended =
  | { status: "completed"; endedAt?: number; lastAnswer?: string }
  | { status: "errored"; endedAt?: number; error?: string }
  | { status: "interrupted"; endedAt?: number };

type Recorded = Pick<AgentNode, "endedAt" | "error" | "lastAnswer" | "status">;

const settled = (outcome: ChildTurnOutcome, endedAt: number): Ended => {
  if (outcome.status === "completed") {
    return outcome.text === undefined
      ? { endedAt, status: "completed" }
      : {
          endedAt,
          lastAnswer: bound(outcome.text, MAX_STATUS_TEXT),
          status: "completed",
        };
  }

  return outcome.status === "errored"
    ? {
        endedAt,
        error: bound(outcome.error, MAX_STATUS_TEXT),
        status: "errored",
      }
    : { endedAt, status: "interrupted" };
};

const restored = (node: Recorded): Ended => {
  const { endedAt, error, lastAnswer, status } = node;
  const at = endedAt === undefined ? {} : { endedAt };

  if (status === "running") {
    return { status: "interrupted" };
  }

  if (status === "completed") {
    return lastAnswer === undefined
      ? { ...at, status }
      : { ...at, lastAnswer, status };
  }

  if (status === "errored") {
    return error === undefined ? { ...at, status } : { ...at, error, status };
  }

  return { ...at, status };
};

const unclaimed = types<{ ended: null; turn: null }>();

const finished = types<{ ended: Ended; turn: null }>();

export const agentMachine = setup({
  schemas: {
    events: {
      "spawn.reserve": types<object>(),
      "spawn.started": types<{ turn: Turn }>(),
      "spawn.failed": types<object>(),
      "followup.reserve": types<object>(),
      "followup.started": types<{ turn: Turn }>(),
      "followup.failed": types<object>(),
      "turn.settled": types<{
        at: number;
        outcome: ChildTurnOutcome;
        turn: Turn;
      }>(),
      interrupt: types<{ at: number }>(),
      "retire.done": types<{ turn: Turn }>(),
      "tree.restore": types<{ node: Recorded }>(),
    },
  },
  states: {
    absent: { schemas: { context: unclaimed } },
    spawning: { schemas: { context: unclaimed } },
    reloading: { schemas: { context: finished } },
    running: { schemas: { context: types<{ ended: null; turn: Turn }>() } },
    retiring: { schemas: { context: types<{ ended: Ended; turn: Turn }>() } },
    idle: { schemas: { context: finished } },
  },
}).createFSM({
  initial: "absent",
  context: { ended: null, turn: null },
  states: {
    absent: {
      on: {
        "spawn.reserve": { target: "spawning" },
        "tree.restore": ({ event }) => ({
          target: "idle",
          context: { ended: restored(event.node) },
        }),
      },
    },
    spawning: {
      on: {
        "spawn.started": ({ event }) => ({
          target: "running",
          context: { turn: event.turn },
        }),
        "spawn.failed": { target: "absent" },
      },
    },
    reloading: {
      on: {
        "followup.started": ({ event }) => ({
          target: "running",
          context: { ended: null, turn: event.turn },
        }),
        "followup.failed": { target: "idle" },
      },
    },
    running: {
      on: {
        "turn.settled": ({ context, event }) =>
          event.turn === context.turn
            ? {
                target: "retiring",
                context: { ended: settled(event.outcome, event.at) },
              }
            : undefined,
        interrupt: ({ event }) => ({
          target: "retiring",
          context: { ended: { endedAt: event.at, status: "interrupted" } },
        }),
      },
    },
    retiring: {
      on: {
        "retire.done": ({ context, event }) =>
          event.turn === context.turn
            ? { target: "idle", context: { turn: null } }
            : undefined,
      },
    },
    idle: {
      on: { "followup.reserve": { target: "reloading" } },
    },
  },
});

export type AgentSnapshot = typeof agentMachine.initialState;

export type AgentEvent = Parameters<typeof agentMachine.transition>[1];

export const restore = (node: AgentNode): AgentSnapshot =>
  agentMachine.transition(agentMachine.initialState, {
    type: "tree.restore",
    node,
  })[0];

export const project = (agent: AgentSnapshot): Recorded | null =>
  agent.value === "running" ? { status: "running" } : agent.context.ended;

const HOLDS_SLOT = {
  absent: false,
  spawning: true,
  reloading: true,
  running: true,
  retiring: true,
  idle: false,
} as const satisfies Record<AgentSnapshot["value"], boolean>;

export const holdsSlot = (agent: AgentSnapshot): boolean =>
  HOLDS_SLOT[agent.value];
