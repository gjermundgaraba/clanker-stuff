import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const DATABASE_NAME = "codex-reverse-i-search.sqlite";

const UPSERT_HISTORY_SQL = `
  INSERT INTO history (text, last_used_at)
  VALUES (?, ?)
  ON CONFLICT(text) DO UPDATE SET
    last_used_at = max(history.last_used_at, excluded.last_used_at)
`;

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
      Type.Object({ role: Type.String() }),
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
  let text: string | undefined;
  if ("content" in message && message.role === "user") {
    if (!Array.isArray(message.content)) {
      text = message.content;
    } else {
      text = message.content
        .flatMap((block) => (block.text !== undefined ? [block.text] : []))
        .join("");
    }
  } else if ("command" in message && message.role === "bashExecution") {
    text = `${message.excludeFromContext === true ? "!!" : "!"}${message.command}`;
  }

  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  let timestamp = Number.NaN;
  const messageTimestamp = "timestamp" in message ? message.timestamp : undefined;
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
    const item = textFromEntry(entry);
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

export const openHistoryDatabase = (): DatabaseSync => {
  const { dataDir } = getExtensionStoragePaths("codex-reverse-i-search");
  mkdirSync(dataDir, { recursive: true });
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

export const loadHistory = (database: DatabaseSync): HistoryItem[] =>
  database
    .prepare(
      `
        SELECT text, last_used_at
        FROM history
        ORDER BY last_used_at DESC, id DESC
      `,
    )
    .all()
    .map((row) => {
      const HistoryRowSchema = Type.Object({ last_used_at: Type.Number(), text: Type.String() });
      if (!Value.Check(HistoryRowSchema, row)) {
        throw new TypeError("SQLite returned an invalid history row");
      }
      const parsed = Value.Parse(HistoryRowSchema, row);
      return {
        text: parsed.text,
        timestamp: parsed.last_used_at,
      };
    });

export const getDataVersion = (database: DatabaseSync): number => {
  const version: unknown = database.prepare("PRAGMA data_version").get()?.data_version;
  const NumberSchema = Type.Number();
  if (!Value.Check(NumberSchema, version)) {
    throw new TypeError("SQLite did not return a data version");
  }
  return Value.Parse(NumberSchema, version);
};

const historyFromJsonl = (text: string): HistoryItem[] =>
  text.split(/\r?\n/u).flatMap((line) => {
    if (line.trim() === "") {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (!Value.Check(EntryWireSchema, parsed)) {
        return [];
      }
      const item = textFromEntry(Value.Parse(EntryWireSchema, parsed));
      return item ? [item] : [];
    } catch {
      return [];
    }
  });

export const importPersistentHistory = async (
  database: DatabaseSync,
  currentSessionDirectory: string,
  onProgress: (status: string) => void,
  signal: AbortSignal,
): Promise<number> => {
  signal.throwIfAborted();
  const reportDiscovery = (loaded: number, total: number): void => {
    signal.throwIfAborted();
    onProgress(`discovering history: ${loaded}/${total} files`);
  };
  const defaultRoot = path.join(getAgentDir(), "sessions");
  const sessions = await SessionManager.listAll(reportDiscovery);
  signal.throwIfAborted();
  if (currentSessionDirectory && path.dirname(currentSessionDirectory) !== defaultRoot) {
    sessions.push(...(await SessionManager.listAll(currentSessionDirectory, reportDiscovery)));
    signal.throwIfAborted();
  }

  let files = 0;
  for (const [index, session] of sessions.entries()) {
    let entries: HistoryItem[];
    try {
      entries = historyFromJsonl(await readFile(session.path, "utf-8"));
    } catch {
      // A concurrently deleted or malformed session should not fail the import.
      continue;
    }
    saveHistoryBatch(database, entries);
    files += 1;
    onProgress(`importing history: ${index + 1}/${sessions.length} files`);
    await yieldToEventLoop();
    signal.throwIfAborted();
  }
  return files;
};
