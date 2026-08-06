import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const DATABASE_NAME = "codex-reverse-i-search.sqlite";

const UPSERT_HISTORY_SQL = `
  INSERT INTO history (text, last_used_at)
  VALUES (?, ?)
  ON CONFLICT(text) DO UPDATE SET
    last_used_at = max(history.last_used_at, excluded.last_used_at)
`;

export interface HistoryItem {
  folded: string;
  text: string;
  timestamp: number;
}

const textFromEntry = (entry: SessionEntry): HistoryItem | undefined => {
  if (entry.type !== "message") {
    return undefined;
  }

  const { message } = entry;
  let text: string | undefined;
  if (message.role === "user") {
    text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
  } else if (message.role === "bashExecution") {
    text = `${message.excludeFromContext === true ? "!!" : "!"}${message.command}`;
  }

  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  const timestamp = message.timestamp ?? Date.parse(entry.timestamp);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return {
    folded: trimmed.toLowerCase(),
    text: trimmed,
    timestamp,
  };
};

export const historyFromEntries = (
  entries: readonly SessionEntry[]
): HistoryItem[] =>
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
  const agentDir = getAgentDir();
  mkdirSync(agentDir, { recursive: true });
  const database = new DatabaseSync(path.join(agentDir, DATABASE_NAME));

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

export const saveHistoryItem = (
  database: DatabaseSync,
  item: HistoryItem
): void => {
  database.prepare(UPSERT_HISTORY_SQL).run(item.text, item.timestamp);
};

export const saveHistoryBatch = (
  database: DatabaseSync,
  items: HistoryItem[]
): void => {
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
      `
    )
    .all()
    .map((row) => {
      if (
        row === null ||
        typeof row !== "object" ||
        !("text" in row) ||
        typeof row.text !== "string" ||
        !("last_used_at" in row) ||
        typeof row.last_used_at !== "number"
      ) {
        throw new TypeError("SQLite returned an invalid history row");
      }
      return {
        folded: row.text.toLowerCase(),
        text: row.text,
        timestamp: row.last_used_at,
      };
    });

export const getDataVersion = (database: DatabaseSync): number => {
  const version = database.prepare("PRAGMA data_version").get()?.data_version;
  if (typeof version !== "number") {
    throw new TypeError("SQLite did not return a data version");
  }
  return version;
};

export const importPersistentHistory = async (
  database: DatabaseSync,
  currentSessionDirectory: string,
  onProgress: (status: string) => void
): Promise<number> => {
  const defaultRoot = path.join(getAgentDir(), "sessions");
  const sessions = await SessionManager.listAll((loaded, total) => {
    onProgress(`discovering history: ${loaded}/${total} files`);
  });
  if (
    currentSessionDirectory &&
    path.dirname(currentSessionDirectory) !== defaultRoot
  ) {
    sessions.push(
      ...(await SessionManager.listAll(
        currentSessionDirectory,
        (loaded, total) => {
          onProgress(`discovering history: ${loaded}/${total} files`);
        }
      ))
    );
  }

  let files = 0;
  for (const [index, session] of sessions.entries()) {
    let entries: SessionEntry[] | undefined;
    try {
      entries = SessionManager.open(session.path).getEntries();
    } catch {
      // A concurrently deleted or malformed session should not fail the import.
    }
    if (entries) {
      saveHistoryBatch(database, historyFromEntries(entries));
      files += 1;
    }
    onProgress(`importing history: ${index + 1}/${sessions.length} files`);
    // oxlint-disable-next-line no-await-in-loop -- keep the TUI responsive during import
    await yieldToEventLoop();
  }
  return files;
};
