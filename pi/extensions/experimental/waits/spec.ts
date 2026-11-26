import { Type } from "typebox";
import type { Static } from "typebox";

// https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
const MAX_SETTIMEOUT_SECONDS = 24 * 24 * 60 * 60;

export const DEFAULTS = {
  intervalSeconds: 15,
  timeoutSeconds: 3600,
  checkTimeoutSeconds: 30,
} as const;

const seconds = (description: string) =>
  Type.Integer({ minimum: 1, maximum: MAX_SETTIMEOUT_SECONDS, description });

const label = Type.String({
  minLength: 1,
  maxLength: 80,
  description: "Short display name.",
});

const condition = Type.String({
  minLength: 1,
  maxLength: 4096,
  description:
    "Side-effect-free command for /bin/sh -c, run in Pi's working directory; exit 0 means the wait is satisfied. Output is discarded.",
});

const instruction = Type.String({
  minLength: 1,
  description:
    "What you should do when woken, written for yourself in a later turn or a restarted session.",
});

const intervalSeconds = seconds(
  `Seconds between checks; default ${DEFAULTS.intervalSeconds}.`
);

const checkTimeoutSeconds = seconds(
  `Limit for one check; default ${DEFAULTS.checkTimeoutSeconds}.`
);

export const startParameters = Type.Object(
  {
    label,
    condition,
    instruction,
    intervalSeconds: Type.Optional(intervalSeconds),
    timeoutSeconds: Type.Optional(
      seconds(
        `Lifetime from now, counted while Pi is closed too; default ${DEFAULTS.timeoutSeconds}.`
      )
    ),
    checkTimeoutSeconds: Type.Optional(checkTimeoutSeconds),
  },
  { additionalProperties: false }
);

export type StartRequest = Static<typeof startParameters>;

export const specSchema = Type.Object(
  {
    label,
    condition,
    instruction,
    cwd: Type.String({ minLength: 1 }),
    intervalSeconds,
    checkTimeoutSeconds,
  },
  { additionalProperties: false }
);

export type WaitSpec = Static<typeof specSchema>;
