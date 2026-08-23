import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ForkTurns = "none" | "all" | number;

type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];
type ForkedMessage = Extract<ContextMessage, { role: "assistant" | "user" }>;

const sanitizeMessage = (
  message: ContextMessage
): ForkedMessage | undefined => {
  if (message.role === "user") {
    return structuredClone(message);
  }
  if (message.role === "compactionSummary") {
    return {
      content: `Previous conversation summary:\n${message.summary}`,
      role: "user",
      timestamp: message.timestamp,
    };
  }
  if (
    message.role !== "assistant" ||
    (message.stopReason !== "stop" && message.stopReason !== "length")
  ) {
    return undefined;
  }

  const content = message.content.filter((item) => item.type === "text");
  if (content.length === 0) {
    return undefined;
  }
  return {
    api: message.api,
    content: structuredClone(content),
    model: message.model,
    provider: message.provider,
    role: "assistant",
    stopReason: message.stopReason,
    timestamp: message.timestamp,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        total: 0,
      },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  };
};

export const forkHistory = (
  entries: readonly SessionEntry[],
  turns: ForkTurns
): ForkedMessage[] => {
  if (turns === "none") {
    return [];
  }

  let messages = entries.flatMap(sessionEntryToContextMessages);
  if (typeof turns === "number") {
    let remaining = turns;
    let start = messages.length;
    while (start > 0 && remaining > 0) {
      start -= 1;
      if (messages[start]?.role === "user") {
        remaining -= 1;
      }
    }
    messages = messages.slice(start);
  }

  return messages
    .map(sanitizeMessage)
    .filter((message): message is ForkedMessage => message !== undefined);
};
