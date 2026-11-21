import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { ownedWaits, WAIT_ENTRY, waitEntry } from "../journal.js";

let sequence = 0;

export const customEntry = (
  data: unknown,
  customType = WAIT_ENTRY
): SessionEntry => {
  sequence += 1;

  return {
    type: "custom",
    customType,
    data,
    id: `e${sequence}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
  };
};

/** Journals a persisted wait, round-trips it through JSON, and reads it back. */
export const journaledSnapshot = async (id: string, persisted: unknown) => {
  const stored = JSON.stringify(waitEntry("s1", id, persisted));
  const [snapshot] = await ownedWaits([customEntry(JSON.parse(stored))], "s1");

  if (snapshot === undefined) {
    throw new Error("The journaled wait did not read back");
  }

  return snapshot;
};
