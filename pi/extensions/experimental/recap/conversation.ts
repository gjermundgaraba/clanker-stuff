import { Buffer } from "node:buffer";

import { contentText } from "@earendil-works/pi-ai";
import type { StopReason } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

import { parseRecapEntry, RECAP_ENTRY_TYPE, RECAP_MAX_CHARS, sanitizeRecapText } from "./entry.js";

export const MIN_COMPLETED_TURNS = 3;
export const MIN_TURNS_BETWEEN_RECAPS = 2;
export const RECAP_HISTORY_MAX_TURNS = 8;
export const RECAP_PROMPT_MAX_BYTES = 900;
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
      const recap = parseRecapEntry(entry.data);
      if (recap !== undefined) {
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
}: ConversationProgress): boolean =>
  completedTurns >= MIN_COMPLETED_TURNS &&
  (lastRecappedTurns === undefined ||
    completedTurns - lastRecappedTurns >= MIN_TURNS_BETWEEN_RECAPS);

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    result += character;
  }
  return result;
};

const renderMessage = (
  { role, text }: ConversationMessage,
  maxBytes: number,
): string | undefined => {
  const prefix = `${role}: `;
  const contentBudget = maxBytes - Buffer.byteLength(prefix);
  if (contentBudget < 0) {
    return undefined;
  }
  const content = truncateUtf8(text, contentBudget);
  return content.length === 0 ? undefined : `${prefix}${content}`;
};

const selectMessages = (entries: readonly SessionEntry[]): ConversationMessage[] => {
  const messages: ConversationMessage[] = [];
  let userTurns = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || !isConversationMessage(entry)) {
      continue;
    }
    if (
      entry.message.role === "assistant" &&
      (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")
    ) {
      continue;
    }

    const text = contentText(entry.message.content).trim();
    if (text.length === 0) {
      continue;
    }

    const role = entry.message.role === "user" ? "User" : "Assistant";
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

const fitHistory = (messages: readonly ConversationMessage[]): string => {
  if (messages.length === 0) {
    return "";
  }

  const byteBudget = Math.max(0, RECAP_PROMPT_MAX_BYTES - Buffer.byteLength(RECAP_PROMPT_PREFIX));
  const latestUserIndex = messages.findLastIndex(({ role }) => role === "User");
  const latestIndex = latestUserIndex === -1 ? messages.length - 1 : latestUserIndex;
  const latest = messages[latestIndex];
  if (latest === undefined) {
    return "";
  }

  const latestRendered = renderMessage(latest, Math.floor(byteBudget / 2)) ?? "";
  const selected: { index: number; rendered: string }[] = [
    { index: latestIndex, rendered: latestRendered },
  ];
  let remaining = byteBudget - Buffer.byteLength(latestRendered);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (index === latestIndex) {
      continue;
    }
    if (remaining <= 2) {
      break;
    }
    const message = messages[index];
    if (message === undefined) {
      break;
    }
    const rendered = renderMessage(message, remaining - 2);
    if (rendered === undefined) {
      break;
    }
    remaining -= Buffer.byteLength(rendered) + 2;
    selected.push({ index, rendered });
  }

  return selected
    .toSorted((left, right) => left.index - right.index)
    .map(({ rendered }) => rendered)
    .join("\n\n");
};

export const buildRecapPrompt = (entries: readonly SessionEntry[]): string | undefined => {
  const messages = selectMessages(entries);
  const history = fitHistory(messages);
  if (history.length === 0) {
    return undefined;
  }
  return `${RECAP_PROMPT_PREFIX}${history.trim()}`;
};

export const normalizeRecap = (value: string): string | undefined => {
  const trimmed = sanitizeRecapText(value).trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return Array.from(trimmed).slice(0, RECAP_MAX_CHARS).join("");
};
