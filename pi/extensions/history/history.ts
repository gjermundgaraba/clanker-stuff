import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
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

/** A `$name` mention, the syntax dollah-skills loads skills from. */
const SKILL_MENTION = /\$(?<name>[A-Za-z0-9_:-]*[A-Za-z0-9_-])/gu;

/**
 * Sessions store skill invocations expanded. Recover a re-runnable prompt. Typed text that mentions
 * every skill its block names reloads them itself, so it is the prompt as written; any other block
 * came from Pi's `/skill:name args`. A dollah-skills block names several skills as `a, b`.
 */
export const typedPrompt = (text: string): string => {
  const skill = parseSkillBlock(text);

  if (!skill) return text;
  const typed = skill.userMessage ?? "";

  const mentioned = new Set(
    typed
      .matchAll(SKILL_MENTION)
      .flatMap((match) => (match.groups?.name ? [match.groups.name] : [])),
  );

  if (skill.name.split(", ").every((name) => mentioned.has(name))) return typed;

  return typed === "" ? `/skill:${skill.name}` : `/skill:${skill.name} ${typed}`;
};

const textFromEntry = (entry: EntryWire): HistoryItem | undefined => {
  const { message } = entry;

  if (message === undefined) {
    return undefined;
  }

  let text: string;

  if (message.role === "user") {
    text = typedPrompt(
      Array.isArray(message.content)
        ? message.content
            .flatMap((block) => (block.text !== undefined ? [block.text] : []))
            .join("")
        : message.content,
    );
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

export const historyItemFromEntry = (entry: unknown): HistoryItem | undefined =>
  Value.Check(EntryWireSchema, entry) ? textFromEntry(entry) : undefined;
