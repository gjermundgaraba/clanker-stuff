import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const userEntry = (
  id: string,
  parentId: string | null,
  text: string,
  timestamp: number
): SessionEntry => ({
  id,
  message: { content: text, role: "user", timestamp },
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  type: "message",
});
