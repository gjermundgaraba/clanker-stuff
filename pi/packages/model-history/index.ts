import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Pi v1's virtual API marker; failed routing can leave this API on an error message. */
export const isVirtualModel = (model: { api: string }): boolean =>
  model.api === "pi-virtual";

export interface ModelHistory {
  lastSuccessfulResponse: AssistantMessage | undefined;
  lastPhysicalAttempt: AssistantMessage | undefined;
}

/** Reads persisted history; `turn_end` and later events see the finished response appended. */
export const inspectModelHistory = (
  branch: readonly SessionEntry[]
): ModelHistory => {
  let lastPhysicalAttempt: AssistantMessage | undefined;

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];

    if (entry?.type !== "message") {
      continue;
    }

    const { message } = entry;

    if (
      message.role !== "assistant" ||
      isVirtualModel(message) ||
      message.stopReason === "pending"
    ) {
      continue;
    }

    lastPhysicalAttempt ??= message;

    if (["stop", "toolUse", "length"].includes(message.stopReason)) {
      return { lastSuccessfulResponse: message, lastPhysicalAttempt };
    }
  }

  return { lastSuccessfulResponse: undefined, lastPhysicalAttempt };
};
