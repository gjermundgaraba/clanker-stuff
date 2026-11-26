import { randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { writeAtomic } from "./registry.js";

export const letterSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    text: Type.String(),
    sentAt: Type.Integer(),
    replyTo: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export type Letter = Static<typeof letterSchema>;

const inboxOf = (dir: string, sessionId: string): string =>
  path.join(dir, encodeURIComponent(sessionId));

export const post = async (
  dir: string,
  sessionId: string,
  letter: Omit<Letter, "id">
): Promise<Letter> => {
  const id = `m_${randomBytes(4).toString("hex")}`;
  const posted = { ...letter, id };

  await writeAtomic(
    path.join(
      inboxOf(dir, sessionId),
      `${String(letter.sentAt).padStart(15, "0")}-${id}.json`
    ),
    posted
  );

  return posted;
};

const takeOne = async (file: string): Promise<Letter | undefined> => {
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
    await rm(file);
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return Value.Check(letterSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const takeAtMostOnce = async (
  dir: string,
  sessionId: string
): Promise<Letter[]> => {
  const inbox = inboxOf(dir, sessionId);
  const files = await readdir(inbox).catch(() => []);
  const letters: Letter[] = [];

  for (const file of files
    .filter((name) => name.endsWith(".json"))
    .toSorted()) {
    const letter = await takeOne(path.join(inbox, file));

    if (letter !== undefined) {
      letters.push(letter);
    }
  }

  return letters;
};
