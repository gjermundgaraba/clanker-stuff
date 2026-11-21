import { Type } from "typebox";
import type { Static } from "typebox";

/**
 * The channel on `pi.events` where an extension reports the work this
 * session has parked with it. Each report replaces that source's earlier one,
 * so a source sends its whole current list every time it changes, and an
 * empty list when nothing is parked.
 */
export const PARKED_CHANNEL = "presence:parked";

export const parkedItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    about: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const parkedReportSchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    items: Type.Array(parkedItemSchema),
  },
  { additionalProperties: false }
);

export type ParkedItem = Static<typeof parkedItemSchema>;

export type ParkedReport = Static<typeof parkedReportSchema>;
