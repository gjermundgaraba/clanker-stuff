import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const zeroUsage = {
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
};

export const userEntry = (
  id: string,
  parentId: string | null,
  text: string,
  timestamp: number,
): SessionEntry => ({
  id,
  message: { content: text, role: "user", timestamp },
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  type: "message",
});

export const nonPromptEntries = (parentId: string | null, timestamp: number): SessionEntry[] => [
  {
    id: "assistant",
    message: {
      api: "faux",
      content: [{ text: "non-prompt assistant content", type: "text" }],
      model: "faux",
      provider: "faux",
      role: "assistant",
      stopReason: "stop",
      timestamp,
      usage: zeroUsage,
    },
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    type: "message",
  },
  {
    id: "tool",
    message: {
      content: [{ text: "non-prompt tool content", type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: timestamp + 1,
      toolCallId: "call",
      toolName: "test",
    },
    parentId: "assistant",
    timestamp: new Date(timestamp + 1).toISOString(),
    type: "message",
  },
  {
    id: "custom",
    message: {
      content: "non-prompt custom content",
      customType: "test",
      display: true,
      role: "custom",
      timestamp: timestamp + 2,
    },
    parentId: "tool",
    timestamp: new Date(timestamp + 2).toISOString(),
    type: "message",
  },
];
