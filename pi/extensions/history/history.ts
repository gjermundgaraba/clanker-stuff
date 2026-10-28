import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface HistoryItem {
  text: string;
  timestamp: number;
}

const EntryWireSchema = Type.Object({
  message: Type.Union([
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
          })
        ),
      ]),
      role: Type.Literal("user"),
      timestamp: Type.Optional(Type.Number()),
    }),
  ]),
  timestamp: Type.Optional(Type.String()),
});

const SKILL_MENTION = /\$[A-Za-z0-9_:-]*[A-Za-z0-9_-]/gu;

export const typedPrompt = (text: string): string => {
  const skill = parseSkillBlock(text);

  if (!skill) {
    return text;
  }

  const typed = skill.userMessage ?? "";

  const mentioned = new Set(
    typed.matchAll(SKILL_MENTION).map((match) => match[0].slice(1))
  );

  if (skill.name.split(", ").every((name) => mentioned.has(name))) {
    return typed;
  }

  return typed === ""
    ? `/skill:${skill.name}`
    : `/skill:${skill.name} ${typed}`;
};

export const bashPrompt = (
  command: string,
  excludeFromContext: boolean | undefined
): string => `${excludeFromContext === true ? "!!" : "!"}${command}`;

export const historyItemFromEntry = (
  entry: unknown
): HistoryItem | undefined => {
  if (!Value.Check(EntryWireSchema, entry)) {
    return undefined;
  }

  const { message } = entry;

  const text = (
    message.role === "user"
      ? typedPrompt(
          Array.isArray(message.content)
            ? message.content.map((block) => block.text ?? "").join("")
            : message.content
        )
      : bashPrompt(message.command, message.excludeFromContext)
  ).trim();

  const timestamp = message.timestamp ?? Date.parse(entry.timestamp ?? "");

  if (!text || !Number.isFinite(timestamp)) {
    return undefined;
  }

  return { text, timestamp };
};
