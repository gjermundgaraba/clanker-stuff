import { mkdirSync } from "node:fs";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import { Type } from "typebox";
import { Value } from "typebox/value";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 1;

export type CodexObservationKind = "compaction" | "context-frame-failure" | "request";

export interface CodexObservation {
  readonly data: unknown;
  readonly kind: CodexObservationKind;
  readonly timestamp: number;
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const ObservationRowSchema = Type.Object({
  data: Type.String(),
  kind: Type.Union([
    Type.Literal("compaction"),
    Type.Literal("context-frame-failure"),
    Type.Literal("request"),
  ]),
  timestamp: Type.Number(),
});

export class CodexObservability {
  #database?: DatabaseSync;
  #insert?: StatementSync;
  #lastError?: string;
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get path(): string {
    return this.#path;
  }

  useMemory(): void {
    if (this.#path !== ":memory:") {
      this.close();
      this.#path = ":memory:";
    }
  }

  close(): void {
    try {
      this.#database?.close();
    } catch (error) {
      this.#lastError = errorMessage(error);
    } finally {
      this.#database = undefined;
      this.#insert = undefined;
    }
  }

  record<T>(
    sessionId: string,
    kind: CodexObservationKind,
    data: T,
    timestamp = Date.now(),
  ): boolean {
    try {
      const database = this.#open();
      if (!database) {
        return false;
      }
      this.#insert ??= database.prepare(
        "INSERT INTO events (timestamp, session_id, kind, data) VALUES (?, ?, ?, ?)",
      );
      this.#insert.run(timestamp, sessionId, kind, JSON.stringify(data) ?? null);
      this.#lastError = undefined;
      return true;
    } catch (error) {
      this.#lastError = errorMessage(error);
      return false;
    }
  }

  list(sessionId: string): CodexObservation[] {
    try {
      const database = this.#open();
      if (!database) {
        return [];
      }
      const rows = database
        .prepare(
          `SELECT timestamp, kind, data
           FROM events
           WHERE session_id = ?
           ORDER BY id DESC`,
        )
        .all(sessionId);
      return rows.map((row): CodexObservation => {
        if (!Value.Check(ObservationRowSchema, row)) {
          throw new TypeError("SQLite returned an invalid observation row");
        }
        const parsed = Value.Parse(ObservationRowSchema, row);
        return {
          data: JSON.parse(parsed.data),
          kind: parsed.kind,
          timestamp: parsed.timestamp,
        };
      });
    } catch (error) {
      this.#lastError = errorMessage(error);
      return [];
    }
  }

  #open(): DatabaseSync | undefined {
    if (this.#database) {
      return this.#database;
    }
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(nodePath.dirname(this.path), { recursive: true });
      database = new DatabaseSync(this.path);
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("PRAGMA journal_mode = WAL");
      if (database.prepare("PRAGMA user_version").get()?.user_version !== SCHEMA_VERSION) {
        database.exec(`
          DROP TABLE IF EXISTS events;
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_session
          ON events(session_id, id);
      `);
      database.prepare("DELETE FROM events WHERE timestamp < ?").run(Date.now() - RETENTION_MS);
      this.#database = database;
      return database;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the setup error.
      }
      this.#lastError = errorMessage(error);
      return undefined;
    }
  }
}
