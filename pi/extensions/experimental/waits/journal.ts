import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { specSchema } from "./spec.js";

export const OPENED = "waits:opened";

export const ENDED = "waits:ended";

export const openedSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    owner: Type.String({ minLength: 1 }),
    spec: specSchema,
    expiresAt: Type.Number(),
  },
  { additionalProperties: false }
);

export const endedSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    outcome: Type.Union([
      Type.Literal("satisfied"),
      Type.Literal("expired"),
      Type.Literal("cancelled"),
    ]),
  },
  { additionalProperties: false }
);

export type Opened = Static<typeof openedSchema>;

export type Ended = Static<typeof endedSchema>;

export const liveWaitsAcrossBranches = (
  entries: readonly SessionEntry[],
  owner: string
): Opened[] => {
  const opened = new Map<string, Opened>();
  const ended = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    if (
      entry.customType === OPENED &&
      Value.Check(openedSchema, entry.data) &&
      entry.data.owner === owner
    ) {
      opened.set(entry.data.id, entry.data);
    }

    if (entry.customType === ENDED && Value.Check(endedSchema, entry.data)) {
      ended.add(entry.data.id);
    }
  }

  return [...opened.values()].filter((wait) => !ended.has(wait.id));
};

export const labelOf = (
  entries: readonly SessionEntry[],
  id: string
): string | undefined => {
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === OPENED &&
      Value.Check(openedSchema, entry.data) &&
      entry.data.id === id
    ) {
      return entry.data.spec.label;
    }
  }

  return undefined;
};
