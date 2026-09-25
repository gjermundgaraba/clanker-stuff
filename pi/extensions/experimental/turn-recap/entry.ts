import { Type } from "typebox";
import type { Static } from "typebox";

import { RECAP_MAX_CHARS } from "./conversation.js";
import { MetricsSchema, UsageSchema } from "./metrics.js";

/** The transcript card, written as soon as its run settles. */
export const ENTRY_TYPE = "@clanker-stuff/turn-recap";

/** A run's recap, written when it arrives; it renders inside its run's card. */
export const RECAP_ENTRY_TYPE = "@clanker-stuff/turn-recap/recap";

const closed = { additionalProperties: false } as const;

export const SnapshotSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    startedAt: Type.Number({ minimum: 0 }),
    finishedAt: Type.Number({ minimum: 0 }),
    activeMs: Type.Number({ minimum: 0 }),
    wallMs: Type.Number({ minimum: 0 }),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    metrics: MetricsSchema,
  },
  closed,
);

export type Snapshot = Static<typeof SnapshotSchema>;

const RecapSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("ready"),
      text: Type.String({ minLength: 1, maxLength: RECAP_MAX_CHARS }),
      usage: UsageSchema,
    },
    closed,
  ),
  Type.Object(
    {
      status: Type.Literal("failed"),
      error: Type.String(),
      usage: Type.Optional(UsageSchema),
    },
    closed,
  ),
]);

export type Recap = Static<typeof RecapSchema>;

export const RecapEntrySchema = Type.Object(
  { runId: Type.String({ minLength: 1 }), recap: RecapSchema },
  closed,
);
