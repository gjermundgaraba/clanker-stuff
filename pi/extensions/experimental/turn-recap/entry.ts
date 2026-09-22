import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { RECAP_MAX_CHARS } from "./conversation.js";
import { MetricsSchema, UsageSchema } from "./metrics.js";

export const ENTRY_TYPE = "@clanker-stuff/turn-recap";

const closed = { additionalProperties: false } as const;

const RecapSchema = Type.Union([
  Type.Object({ status: Type.Literal("off") }, closed),
  Type.Object({ status: Type.Literal("pending") }, closed),
  Type.Object({ status: Type.Literal("cancelled") }, closed),
  Type.Object(
    {
      status: Type.Literal("failed"),
      error: Type.String(),
      usage: Type.Optional(UsageSchema),
    },
    closed,
  ),
  Type.Object(
    {
      status: Type.Literal("ready"),
      text: Type.String({ minLength: 1, maxLength: RECAP_MAX_CHARS }),
      usage: UsageSchema,
    },
    closed,
  ),
]);

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
    recap: RecapSchema,
  },
  closed,
);

export type Snapshot = Static<typeof SnapshotSchema>;

export type Recap = Snapshot["recap"];

/** Each update is a full snapshot with the same runId. Never mutate Pi's JSONL. */
export const restoreSnapshots = (entries: readonly SessionEntry[]) => {
  let current: Snapshot | undefined;
  let previousRecap: string | undefined;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data;

    if (!Value.Check(SnapshotSchema, data)) continue;

    if (current?.runId !== data.runId && current?.recap.status === "ready") {
      previousRecap = current.recap.text;
    }

    current = data;
  }

  // No request survives a process reload. Do not restart or leave a phantom spinner.
  if (current?.recap.status === "pending") {
    current = { ...current, recap: { status: "cancelled" } };
  }

  return { current, previousRecap };
};
