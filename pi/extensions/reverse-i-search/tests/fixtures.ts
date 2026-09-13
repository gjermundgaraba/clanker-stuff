import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
    message: fauxAssistantMessage("non-prompt assistant content", { timestamp }),
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
