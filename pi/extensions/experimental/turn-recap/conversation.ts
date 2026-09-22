import { contentText } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

import { safeText } from "@clanker-stuff/pi-tool-rendering/text";

import type { Snapshot } from "./entry.js";

export const RECAP_MAX_CHARS = 320;

export const sanitizeRecapText = (value: string): string =>
  safeText(value).replace(/\s+/gu, " ").trim();

export const RECAP_PROMPT_MAX_CHARS = 12_000;

export const RECAP_PROMPT_PREFIX =
  "Write a brief catch-up for a user returning to this Pi task. " +
  "In at most 40 words and one or two plain-text sentences, explain the " +
  "objective, what was completed or learned, and the next step or blocker. " +
  "Mention changed files, tests, approvals, or requested decisions only " +
  "when relevant. Never claim changes were made or tests passed unless " +
  "the conversation confirms it. If the task is complete, say so instead " +
  "of inventing more work. Use the user's language; omit greetings, " +
  "markdown, lists, and tool chatter.\n\nRecent conversation:\n";

/** A bounded excerpt, not a complete history or an exact token-fit guarantee. */
export const buildRecapPrompt = (
  entries: readonly ProjectedSessionEntry[],
  outcome: Snapshot["outcome"],
): string | undefined => {
  const suffix = `\n\nLatest run outcome: ${outcome}. Do not describe an interrupted or failed run as successfully completed.`;
  const excerpts: string[] = [];
  const marker = " [message excerpt; remainder omitted]";
  let remaining = RECAP_PROMPT_MAX_CHARS - RECAP_PROMPT_PREFIX.length - suffix.length;

  selection: for (const { sourceEntry, messages } of entries.toReversed()) {
    // Ignore synthetic compaction/branch summaries.
    if (sourceEntry.type !== "message") continue;

    for (const message of messages.toReversed()) {
      if (message.role !== "user" && message.role !== "assistant") continue;

      if (
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted")
      )
        continue;
      const text = contentText(message.content).trim();

      if (text.length === 0) continue;
      const label = message.role === "user" ? "User: " : "Assistant: ";
      const room = remaining - label.length - (excerpts.length > 0 ? 2 : 0);

      if (room <= marker.length) break selection;
      const clipped = text.length > room;
      const excerpt = clipped ? text.slice(0, room - marker.length).toWellFormed() + marker : text;
      excerpts.push(label + excerpt);
      remaining = room - excerpt.length;

      if (clipped) break selection;
    }
  }

  if (excerpts.length === 0) return undefined;

  return RECAP_PROMPT_PREFIX + excerpts.reverse().join("\n\n") + suffix;
};

export const normalizeRecap = (value: string): string | undefined => {
  const trimmed = sanitizeRecapText(value);

  if (trimmed.length === 0) {
    return undefined;
  }

  return Array.from(trimmed).slice(0, RECAP_MAX_CHARS).join("");
};
