import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { HistoryItem } from "./history.js";

const DATABASE_NAME = "history.sqlite";

const UPSERT_HISTORY_SQL = `
  INSERT INTO history (text, last_used_at)
  VALUES (?, ?)
  ON CONFLICT(text) DO UPDATE SET
    last_used_at = max(history.last_used_at, excluded.last_used_at)
`;

const HistoryRowSchema = Type.Object({ last_used_at: Type.Number(), text: Type.String() });

export const openHistoryDatabase = (): DatabaseSync => {
  const { dataDir } = getExtensionStoragePaths("history");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(dataDir, DATABASE_NAME));

  try {
    database.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL UNIQUE,
        last_used_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS history_recency
      ON history(last_used_at DESC, id DESC);
    `);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const saveHistoryItem = (database: DatabaseSync, item: HistoryItem): void => {
  database.prepare(UPSERT_HISTORY_SQL).run(item.text, item.timestamp);
};

export const saveHistoryBatch = (database: DatabaseSync, items: HistoryItem[]): void => {
  if (items.length === 0) {
    return;
  }

  const statement = database.prepare(UPSERT_HISTORY_SQL);
  database.exec("BEGIN IMMEDIATE");

  try {
    for (const item of items) {
      statement.run(item.text, item.timestamp);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const loadHistory = (database: DatabaseSync, limit = -1): HistoryItem[] =>
  database
    .prepare(
      `
        SELECT text, last_used_at
        FROM history
        ORDER BY last_used_at DESC, id DESC
        LIMIT ?
      `,
    )
    .all(limit)
    .map((row) => {
      if (!Value.Check(HistoryRowSchema, row)) {
        throw new TypeError("SQLite returned an invalid history row");
      }

      return {
        text: row.text,
        timestamp: row.last_used_at,
      };
    });

export const getDataVersion = (database: DatabaseSync): number => {
  const version: unknown = database.prepare("PRAGMA data_version").get()?.data_version;

  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new TypeError("SQLite did not return a data version");
  }

  return version;
};
