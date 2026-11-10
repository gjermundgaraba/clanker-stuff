import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { RequestRecordSchema, StateRecordSchema } from "./interaction.js";
import type { Interaction, RequestRecord } from "./interaction.js";

export const REQUEST_TYPE = "ask-question.request";

export const STATE_TYPE = "ask-question.state";

type Writer = Pick<ExtensionAPI, "appendEntry">;

export const recordRequest = (pi: Writer, item: Interaction): void => {
  pi.appendEntry(REQUEST_TYPE, { id: item.id, request: item.request });
};

export const recordState = (pi: Writer, item: Interaction): void => {
  pi.appendEntry(STATE_TYPE, {
    id: item.id,
    ...(item.draft ? { draft: item.draft } : {}),
  });
};

/** Rebuilds the questionnaires still open on the active branch, least recently changed first. */
export const replay = (branch: SessionEntry[]): Map<string, Interaction> => {
  const requests = new Map<string, RequestRecord>();
  const items = new Map<string, Interaction>();

  for (const entry of branch) {
    if (entry.type !== "custom") {
      continue;
    }

    if (
      entry.customType === REQUEST_TYPE &&
      Value.Check(RequestRecordSchema, entry.data)
    ) {
      requests.set(entry.data.id, {
        id: entry.data.id,
        request: entry.data.request,
      });
    } else if (
      entry.customType === STATE_TYPE &&
      Value.Check(StateRecordSchema, entry.data)
    ) {
      const request = requests.get(entry.data.id);
      items.delete(entry.data.id);

      if (request && entry.data.draft) {
        items.set(request.id, { ...request, draft: entry.data.draft });
      }
    }
  }

  return items;
};
