import { Value } from "typebox/value";

import { contentText } from "@earendil-works/pi-ai";
import type { StopReason } from "@earendil-works/pi-ai";
import type {
  ProjectedSessionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import { RecapEntrySchema, RECAP_ENTRY_TYPE, RECAP_MAX_CHARS, sanitizeRecapText } from "./entry.js";

export const RECAP_HISTORY_MAX_TURNS = 8;

export const RECAP_PROMPT_PREFIX =
  "Write a brief catch-up for a user returning to this Pi task. " +
  "In at most 40 words and one or two plain-text sentences, explain the " +
  "objective, what was completed or learned, and the next step or blocker. " +
  "Mention changed files, tests, approvals, or requested decisions only " +
  "when relevant. Never claim changes were made or tests passed unless " +
  "the conversation confirms it. If the task is complete, say so instead " +
  "of inventing more work. Use the user's language; omit greetings, " +
  "markdown, lists, and tool chatter.\n\nRecent conversation:\n";

interface ConversationMessage {
  role: "Assistant" | "User";
  text: string;
}

export interface ConversationProgress {
  completedTurns: number;
  lastRecappedTurns: number | undefined;
  sourceRevision: string | undefined;
}

const isConversationMessage = (
  entry: SessionEntry,
): entry is SessionMessageEntry & { message: { role: "assistant" | "user" } } =>
  entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "user");

export const isCompletedTurnStopReason = (stopReason: StopReason | undefined): boolean =>
  stopReason === "stop" || stopReason === "length";

export const conversationProgress = (entries: readonly SessionEntry[]): ConversationProgress => {
  let activeTurn = false;
  let completedTurns = 0;
  let finalStopReason: StopReason | undefined;
  let lastRecappedTurns: number | undefined;
  let sourceRevision: string | undefined;

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === RECAP_ENTRY_TYPE) {
      const recap = entry.data;

      if (Value.Check(RecapEntrySchema, recap)) {
        lastRecappedTurns = recap.completedTurns;
      }

      continue;
    }

    if (!isConversationMessage(entry)) {
      continue;
    }

    sourceRevision = entry.id;

    if (entry.message.role === "user") {
      if (activeTurn && isCompletedTurnStopReason(finalStopReason)) {
        completedTurns += 1;
      }

      activeTurn = true;
      finalStopReason = undefined;
    } else if (activeTurn) {
      finalStopReason = entry.message.stopReason;
    }
  }

  if (activeTurn && isCompletedTurnStopReason(finalStopReason)) {
    completedTurns += 1;
  }

  return { completedTurns, lastRecappedTurns, sourceRevision };
};

export const shouldGenerateRecap = ({
  completedTurns,
  lastRecappedTurns,
}: ConversationProgress): boolean => completedTurns > (lastRecappedTurns ?? 0);

const selectMessages = (entries: readonly ProjectedSessionEntry[]): ConversationMessage[] => {
  const messages: ConversationMessage[] = [];
  let userTurns = 0;

  // Only original conversation entries, not synthetic compaction/branch summaries.
  const conversation = entries.flatMap(({ sourceEntry, messages }) =>
    sourceEntry.type === "message" ? messages : [],
  );

  for (const message of conversation.toReversed()) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    ) {
      continue;
    }

    const text = contentText(message.content).trim();

    if (text.length === 0) {
      continue;
    }

    const role = message.role === "user" ? "User" : "Assistant";
    messages.push({ role, text });

    if (role === "User") {
      userTurns += 1;

      if (userTurns === RECAP_HISTORY_MAX_TURNS) {
        break;
      }
    }
  }

  return messages.reverse();
};

export const buildRecapPrompt = (entries: readonly ProjectedSessionEntry[]): string | undefined => {
  const messages = selectMessages(entries);
  const history = messages.map(({ role, text }) => `${role}: ${text}`).join("\n\n");

  if (history.length === 0) {
    return undefined;
  }

  return `${RECAP_PROMPT_PREFIX}${history}`;
};

export const normalizeRecap = (value: string): string | undefined => {
  const trimmed = sanitizeRecapText(value).trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  return Array.from(trimmed).slice(0, RECAP_MAX_CHARS).join("");
};
