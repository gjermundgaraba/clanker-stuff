import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { TOOLS_STATE_TYPE } from "../state.js";
import type { ToolsState } from "../state.js";

export const createMessageEntry = (options: {
  id: string;
  parentId: string | null;
  text: string;
}): SessionEntry => ({
  id: options.id,
  message: {
    content: options.text,
    role: "user",
    timestamp: 1,
  },
  parentId: options.parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "message",
});

export const createToolsEntry = (options: {
  id: string;
  parentId: string | null;
  data: ToolsState;
}): SessionEntry => ({
  customType: TOOLS_STATE_TYPE,
  data: options.data,
  id: options.id,
  parentId: options.parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "custom",
});
