import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { Type } from "typebox";
import { Value } from "typebox/value";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY,
    cwd TEXT NOT NULL,
    text TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drafts_by_cwd ON drafts(cwd, id);
`;

const PoppedDraftSchema = Type.Object({ text: Type.String() });

const openStore = (): DatabaseSync => {
  const { dataDir } = getExtensionStoragePaths("stash");
  mkdirSync(dataDir, { mode: 0o700, recursive: true });

  const database = new DatabaseSync(path.join(dataDir, "stash.sqlite"), {
    timeout: 250,
  });

  try {
    database.exec(SCHEMA_SQL);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const pushStash = (cwd: string, text: string): void => {
  using database = openStore();

  database
    .prepare("INSERT INTO drafts (cwd, text) VALUES (?, ?)")
    .run(path.resolve(cwd), text);
};

export const popStash = (cwd: string): string | undefined => {
  using database = openStore();

  const row = database
    .prepare(`
      DELETE FROM drafts
      WHERE id = (SELECT id FROM drafts WHERE cwd = ? ORDER BY id DESC LIMIT 1)
      RETURNING text
    `)
    .get(path.resolve(cwd));

  if (row === undefined) {
    return undefined;
  }

  if (!Value.Check(PoppedDraftSchema, row)) {
    throw new TypeError("Invalid stash row");
  }

  return row.text;
};
