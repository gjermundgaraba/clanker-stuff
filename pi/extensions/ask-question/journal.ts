import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { RequestRecordSchema, StateRecordSchema } from "./interaction.js";
import type { Interaction, RequestRecord } from "./interaction.js";

export const REQUEST_TYPE = "questionnaire.request";

export const STATE_TYPE = "questionnaire.state";

type Writer = Pick<ExtensionAPI, "appendEntry">;

/** Persist the authored request once, when the interaction is created. */
export function recordRequest(pi: Writer, item: Interaction): void {
  pi.appendEntry(REQUEST_TYPE, {
    id: item.id,
    request: item.request,
    created_at: item.created_at,
    origin_tool_call_id: item.origin_tool_call_id,
  });
}

/** Persist the interaction's current state. Pi writes custom entries synchronously. */
export function recordState(pi: Writer, item: Interaction): void {
  pi.appendEntry(STATE_TYPE, {
    id: item.id,
    updated_at: item.updated_at,
    cancelled: item.cancelled,
    ...(item.draft ? { draft: item.draft } : {}),
    submissions: item.submissions,
  });
}

/** Rebuild this branch's interactions; the last state of each request wins. */
export function replay(branch: SessionEntry[]): Map<string, Interaction> {
  const requests = new Map<string, RequestRecord>();
  const items = new Map<string, Interaction>();

  for (const entry of branch) {
    if (entry.type !== "custom") continue;

    // Unreadable entries, including retired formats, are skipped rather than blocking the session.
    if (entry.customType === REQUEST_TYPE && Value.Check(RequestRecordSchema, entry.data))
      requests.set(entry.data.id, entry.data);
    else if (entry.customType === STATE_TYPE && Value.Check(StateRecordSchema, entry.data)) {
      const request = requests.get(entry.data.id);

      if (request) items.set(request.id, { ...request, ...entry.data });
    }
  }

  return items;
}
