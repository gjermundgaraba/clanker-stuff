import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export interface HistoryItem {
  text: string;
  timestamp: number;
}

const EntryWireSchema = Type.Object({
  message: Type.Optional(
    Type.Union([
      Type.Object({
        command: Type.String(),
        excludeFromContext: Type.Optional(Type.Boolean()),
        role: Type.Literal("bashExecution"),
        timestamp: Type.Optional(Type.Number()),
      }),
      Type.Object({
        content: Type.Union([
          Type.String(),
          Type.Array(
            Type.Object({
              text: Type.Optional(Type.String()),
              type: Type.Optional(Type.String()),
            }),
          ),
        ]),
        role: Type.Literal("user"),
        timestamp: Type.Optional(Type.Number()),
      }),
    ]),
  ),
  timestamp: Type.Optional(Type.String()),
});

type EntryWire = Static<typeof EntryWireSchema>;

const textFromEntry = (entry: EntryWire): HistoryItem | undefined => {
  const { message } = entry;
  if (message === undefined) {
    return undefined;
  }
  let text: string;
  if (message.role === "user") {
    if (!Array.isArray(message.content)) {
      text = message.content;
    } else {
      text = message.content
        .flatMap((block) => (block.text !== undefined ? [block.text] : []))
        .join("");
    }
  } else {
    text = `${message.excludeFromContext === true ? "!!" : "!"}${message.command}`;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let timestamp = Number.NaN;
  const messageTimestamp = message.timestamp;
  if (messageTimestamp !== undefined) {
    timestamp = messageTimestamp;
  } else if (entry.timestamp !== undefined) {
    timestamp = Date.parse(entry.timestamp);
  }
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return {
    text: trimmed,
    timestamp,
  };
};

export const historyFromEntries = (entries: readonly SessionEntry[]): HistoryItem[] =>
  entries.flatMap((entry) => {
    const item = historyItemFromEntry(entry);
    return item ? [item] : [];
  });

export const normalizeHistory = (items: HistoryItem[]): HistoryItem[] => {
  const seen = new Set<string>();
  return items
    .toSorted((left, right) => right.timestamp - left.timestamp)
    .filter(({ text }) => {
      if (seen.has(text)) {
        return false;
      }
      seen.add(text);
      return true;
    });
};

export const historyItemFromEntry = (entry: unknown): HistoryItem | undefined =>
  Value.Check(EntryWireSchema, entry) ? textFromEntry(entry) : undefined;
