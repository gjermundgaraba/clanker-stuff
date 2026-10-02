import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Pi v1's virtual API marker; failed routing can leave this API on an error message. */
export const isVirtualModel = (model: { api: string }): boolean => model.api === "pi-virtual";

export interface ModelHistory {
  lastSuccessfulResponse: AssistantMessage | undefined;
  lastPhysicalAttempt: AssistantMessage | undefined;
}

/** The optional newest message covers message_end, before it is appended to the session. */
export function inspectModelHistory(
  branch: readonly SessionEntry[],
  newest?: MessageEndEvent["message"],
): ModelHistory {
  const history: ModelHistory = {
    lastSuccessfulResponse: undefined,
    lastPhysicalAttempt: undefined,
  };

  const consider = (message: MessageEndEvent["message"]): void => {
    if (message.role !== "assistant" || isVirtualModel(message) || message.stopReason === "pending")
      return;

    history.lastPhysicalAttempt ??= message;

    if (["stop", "toolUse", "length"].includes(message.stopReason))
      history.lastSuccessfulResponse ??= message;
  };

  if (newest) consider(newest);

  for (
    let index = branch.length - 1;
    index >= 0 && (!history.lastSuccessfulResponse || !history.lastPhysicalAttempt);
    index--
  ) {
    const entry = branch[index];

    if (entry?.type === "message") consider(entry.message);
  }

  return history;
}
