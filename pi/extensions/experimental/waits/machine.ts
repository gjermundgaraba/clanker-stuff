import { createAsyncLogic, setup, types } from "xstate";
import type { SnapshotFrom } from "xstate";

import { runCondition } from "./check.js";
import type { CheckInput, CheckOutcome } from "./check.js";

/** What the agent asked to wait for. Fixed for the wait's lifetime. */
export interface WaitSpec {
  readonly label: string;
  readonly condition: string;
  readonly instruction: string;
  readonly cwd: string;
  readonly intervalMs: number;
  readonly checkTimeoutMs: number;
  readonly timeoutMs: number;
}

export interface WaitContext {
  readonly id: string;
  readonly spec: WaitSpec;
  readonly openedAt: number;
  readonly attempts: number;
  readonly lastCheck?: CheckOutcome;
  readonly endedAt?: number;
}

export interface WaitInput {
  readonly id: string;
  readonly spec: WaitSpec;
  readonly openedAt: number;
}

export const checkLogic = createAsyncLogic({
  run: async ({ input, signal }: { input: CheckInput; signal: AbortSignal }) =>
    await runCondition(input, signal),
});

const checked = (context: WaitContext, outcome: CheckOutcome): WaitContext => ({
  ...context,
  attempts: context.attempts + 1,
  lastCheck: outcome,
});

const ended = (context: WaitContext): WaitContext => ({
  ...context,
  endedAt: Date.now(),
});

/**
 * One wait. `open` polls the condition until it passes or the deadline ends
 * it; `satisfied` holds the result until a wake is handed to Pi. Only the
 * top-level state is journaled, so polling writes nothing.
 */
export const waitMachine = setup({
  schemas: {
    context: types<WaitContext>(),
    input: types<WaitInput>(),
    events: {
      "wait.cancel": types<object>(),
      "wait.delivered": types<object>(),
    },
  },
  actors: { check: checkLogic },
  delays: {
    interval: ({ context }) => context.spec.intervalMs,
  },
}).createMachine({
  id: "wait",
  version: "1",
  context: ({ input }) => ({
    id: input.id,
    spec: input.spec,
    openedAt: input.openedAt,
    attempts: 0,
  }),
  initial: "open",
  states: {
    open: {
      timeout: ({ context }) => context.spec.timeoutMs,
      onTimeout: ({ context }) => ({
        target: "expired",
        context: ended(context),
      }),
      on: {
        "wait.cancel": ({ context }) => ({
          target: "cancelled",
          context: ended(context),
        }),
      },
      initial: "checking",
      states: {
        checking: {
          invoke: {
            id: "check",
            src: "check",
            input: ({ context }) => ({
              command: context.spec.condition,
              cwd: context.spec.cwd,
              timeoutMs: context.spec.checkTimeoutMs,
            }),
            onDone: ({ context, event }) => {
              const next = checked(context, event.output);

              return event.output.exitCode === 0
                ? { target: "#wait.satisfied", context: next }
                : { target: "waiting", context: next };
            },
            onError: ({ context }) => ({
              target: "waiting",
              context: checked(context, { exitCode: null, timedOut: false }),
            }),
          },
        },
        waiting: {
          after: { interval: { target: "checking" } },
        },
      },
    },
    satisfied: {
      on: {
        "wait.delivered": ({ context }) => ({
          target: "fired",
          context: ended(context),
        }),
        "wait.cancel": ({ context }) => ({
          target: "cancelled",
          context: ended(context),
        }),
      },
    },
    fired: { type: "final" },
    expired: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type WaitSnapshot = SnapshotFrom<typeof waitMachine>;

const PHASES = ["open", "satisfied", "fired", "expired", "cancelled"] as const;

export type Phase = (typeof PHASES)[number];

/** The top-level state, which is what the journal records. */
export const phaseOf = (snapshot: WaitSnapshot): Phase => {
  const phase = PHASES.find((candidate) => snapshot.matches(candidate));

  if (phase === undefined) {
    throw new Error("A wait is always in one top-level phase");
  }

  return phase;
};
