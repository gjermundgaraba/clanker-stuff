import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { MESSAGE_TYPE, SENT } from "./entries.js";
import { letterSchema } from "./mailbox.js";
import type { Letter } from "./mailbox.js";

/**
 * The questions this session sent that no letter has answered yet, by letter
 * ID. A sent letter without `replyTo` is a question; a delivered letter whose
 * `replyTo` names it answers it. It reads the whole session, across branches,
 * because an answer arrived in the world, not on a branch.
 */
export const openQuestions = (
  entries: readonly SessionEntry[]
): Map<string, Letter> => {
  const open = new Map<string, Letter>();

  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === SENT &&
      Value.Check(letterSchema, entry.data) &&
      entry.data.replyTo === undefined
    ) {
      open.set(entry.data.id, entry.data);
    }

    if (
      entry.type === "custom_message" &&
      entry.customType === MESSAGE_TYPE &&
      Value.Check(letterSchema, entry.details) &&
      entry.details.replyTo !== undefined
    ) {
      open.delete(entry.details.replyTo);
    }
  }

  return open;
};
