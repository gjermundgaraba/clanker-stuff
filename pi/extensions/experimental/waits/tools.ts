import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { rowOf } from "./report.js";
import type { WaitSummary } from "./report.js";
import { DEFAULTS } from "./runtime.js";
import type { WaitRuntime } from "./runtime.js";

const startParameters = Type.Object(
  {
    label: Type.String({
      minLength: 1,
      maxLength: 80,
      description: "Short display name.",
    }),
    condition: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "Side-effect-free shell command run in your shell; exit 0 means the wait is satisfied. Output is discarded.",
    }),
    instruction: Type.String({
      minLength: 1,
      maxLength: 4000,
      description:
        "What you should do when woken, written for yourself in a later turn or a restarted session.",
    }),
    cwd: Type.Optional(
      Type.String({
        maxLength: 4096,
        description: "Working directory for the condition; defaults to Pi's.",
      })
    ),
    intervalSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3600,
        description: `Seconds between checks; default ${DEFAULTS.intervalSeconds}.`,
      })
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 10,
        maximum: 604_800,
        description: `Absolute lifetime from now, counted while Pi is closed too; default ${DEFAULTS.timeoutSeconds}.`,
      })
    ),
    checkTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 300,
        description: `Limit for one check; default ${DEFAULTS.checkTimeoutSeconds}.`,
      })
    ),
  },
  { additionalProperties: false }
);

const idParameters = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

const result = (text: string, details: { waits: WaitSummary[] }) => ({
  content: [{ type: "text" as const, text }],
  details,
});

export const registerWaitTools = (
  pi: ExtensionAPI,
  runtime: WaitRuntime
): void => {
  pi.registerTool({
    name: "wait_start",
    label: "Start wait",
    description:
      "Wait for a shell condition without blocking. It is checked now and then on an interval; when it exits 0, you are woken once with your instruction. Survives /reload, quitting and relaunching this session, and a killed Pi; it does not survive /new, fork or clone.",
    promptSnippet:
      "Wait on a shell condition that survives restarts, and be woken once when it holds",
    promptGuidelines: [
      "After wait_start, end your turn or keep doing other work; do not poll or sleep to wait. You are woken automatically, even in a restarted session.",
      "Write conditions that fail closed and prove freshness: exit 0 only on evidence that this run finished (a result ID you have not used, a marker unique to this run), never on missing input or a previous run's output.",
      "Put everything a later session needs into instruction: what to do with the result, and how to tell a new result from one already used.",
    ],
    parameters: startParameters,
    execute: async (_id, params, _signal, _update, ctx) => {
      const wait = runtime.open(params, ctx);

      return result(
        `Started ${rowOf(wait)}. End your turn; you will be woken when it is satisfied.`,
        { waits: [wait] }
      );
    },
  });
  pi.registerTool({
    name: "wait_list",
    label: "List waits",
    description:
      "List this branch's waits and their phase: open, satisfied, fired, expired or cancelled.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => result(runtime.rows(), { waits: runtime.list() }),
  });
  pi.registerTool({
    name: "wait_cancel",
    label: "Cancel wait",
    description: "Cancel an open or satisfied wait so it never wakes you.",
    parameters: idParameters,
    execute: async (_id, params) => {
      const wait = runtime.cancel(params.id);

      return result(`Cancelled ${rowOf(wait)}.`, { waits: [wait] });
    },
  });
};
