import { createAsyncLogic, setup, types } from "xstate";
import type { SnapshotFrom } from "xstate";

import { runCondition } from "./check.js";
import type { CheckInput, CheckResult } from "./check.js";
import type { WaitSpec } from "./spec.js";

/** The last check's exit code, or why it has none. */
export type LastResult = CheckResult | "error";

export interface WaitInput {
  readonly id: string;
  readonly spec: WaitSpec;
  readonly remainingMs: number;
}

interface WaitContext extends WaitInput {
  readonly lastResult?: LastResult;
}

export const checkLogic = createAsyncLogic({
  run: async ({ input, signal }: { input: CheckInput; signal: AbortSignal }) =>
    await runCondition(input, signal),
});

/**
 * One wait: its condition is checked at once and then on its interval, until
 * it exits 0 or the remaining time runs out. Both ends are final; the runtime
 * journals and delivers them.
 */
export const waitMachine = setup({
  schemas: {
    context: types<WaitContext>(),
    input: types<WaitInput>(),
  },
  actors: { check: checkLogic },
  delays: {
    interval: ({ context }) => context.spec.intervalSeconds * 1000,
  },
}).createMachine({
  id: "wait",
  context: ({ input }) => input,
  initial: "starting",
  states: {
    starting: {
      type: "choice",
      choice: ({ context }) =>
        context.remainingMs > 0 ? { target: "open" } : { target: "expired" },
    },
    open: {
      timeout: ({ context }) => context.remainingMs,
      onTimeout: { target: "expired" },
      initial: "checking",
      states: {
        checking: {
          invoke: {
            src: "check",
            input: ({ context }) => ({
              command: context.spec.condition,
              cwd: context.spec.cwd,
              timeoutMs: context.spec.checkTimeoutSeconds * 1000,
            }),
            onDone: ({ context, event }) =>
              event.output === 0
                ? {
                    target: "#wait.satisfied",
                    context: { ...context, lastResult: event.output },
                  }
                : {
                    target: "waiting",
                    context: { ...context, lastResult: event.output },
                  },
            onError: ({ context }) => ({
              target: "waiting",
              context: { ...context, lastResult: "error" },
            }),
          },
        },
        waiting: {
          after: { interval: { target: "checking" } },
        },
      },
    },
    satisfied: { type: "final" },
    expired: { type: "final" },
  },
});

export type WaitSnapshot = SnapshotFrom<typeof waitMachine>;
