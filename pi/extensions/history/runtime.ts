import type { DatabaseSync } from "node:sqlite";

import { acquireEditorHost } from "@clanker-stuff/editor";
import type {
  ExtensionContext,
  InputEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";

import { bashPrompt, typedPrompt } from "./history.js";
import type { HistoryItem } from "./history.js";
import { importPersistentHistory } from "./import.js";
import { createSearch } from "./search.js";
import {
  getDataVersion,
  loadHistory,
  openHistoryDatabase,
  openMemoryDatabase,
  saveHistoryItem,
} from "./storage.js";

const STATUS_KEY = "history";

const RECALL_LIMIT = 100;

export const createHistoryRuntime = () => {
  let database: DatabaseSync | undefined;
  let persistent = false;
  let history: HistoryItem[] = [];
  let databaseVersion: number | undefined;
  let closeSearch: (() => void) | undefined;
  const session = new AbortController();
  let importSettled: Promise<Array<PromiseSettledResult<number>>> | undefined;
  let persistenceWarningShown = false;

  const warnPersistence = (
    ui: ExtensionContext["ui"],
    cause: unknown
  ): void => {
    if (persistenceWarningShown) {
      return;
    }

    persistenceWarningShown = true;
    const message = cause instanceof Error ? `: ${cause.message}` : "";
    ui.notify(`Prompt history persistence is unavailable${message}`, "warning");
  };

  const start = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      return;
    }

    if (ctx.sessionManager.getSessionDir() !== "") {
      try {
        database = openHistoryDatabase();
        persistent = true;
      } catch (error) {
        warnPersistence(ctx.ui, error);
      }
    }

    database ??= openMemoryDatabase();
    let recent: HistoryItem[] = [];

    try {
      recent = loadHistory(database, RECALL_LIMIT);
    } catch (error) {
      warnPersistence(ctx.ui, error);
    }

    acquireEditorHost(ctx)?.seedHistory(
      recent.map(({ text }) => text).toReversed()
    );
  };

  const record = (text: string, ui: ExtensionContext["ui"]) => {
    const trimmed = text.trim();

    if (!database || !trimmed) {
      return;
    }

    const item = { text: trimmed, timestamp: Date.now() };
    history = [item, ...history.filter((entry) => entry.text !== trimmed)];

    try {
      saveHistoryItem(database, item);
    } catch (error) {
      warnPersistence(ui, error);
    }
  };

  const snapshot = (
    activeDatabase: DatabaseSync,
    ui: ExtensionContext["ui"]
  ) => {
    try {
      const version = getDataVersion(activeDatabase);

      if (version !== databaseVersion) {
        history = loadHistory(activeDatabase);
        databaseVersion = version;
      }
    } catch (error) {
      warnPersistence(ui, error);
    }

    return history;
  };

  const open = async (ctx: ExtensionContext) => {
    if (!database) {
      return;
    }

    const items = snapshot(database, ctx.ui);

    const accepted = await ctx.ui.custom<string | undefined>(
      (_tui, theme, _keybindings, done) => {
        closeSearch = () => {
          done(undefined);
        };

        return createSearch(items, theme, done);
      }
    );

    closeSearch = undefined;

    if (accepted !== undefined) {
      ctx.ui.setEditorText(accepted);
    }
  };

  const importHistory = async (ctx: ExtensionContext) => {
    if (!database) {
      return;
    }

    if (!persistent) {
      ctx.ui.notify("Prompt history persistence is unavailable", "warning");

      return;
    }

    if (importSettled) {
      ctx.ui.notify("Session history import is already running.", "warning");

      return;
    }

    const imported = importPersistentHistory(
      database,
      ctx.sessionManager.getSessionDir(),
      (status) => {
        ctx.ui.setStatus(STATUS_KEY, status);
      },
      session.signal
    );

    importSettled = Promise.allSettled([imported]);

    try {
      const files = await imported;
      ctx.ui.notify(
        `Imported prompt history from ${files} session files.`,
        "info"
      );
    } catch (error) {
      if (!session.signal.aborted) {
        const message = error instanceof Error ? `: ${error.message}` : "";
        ctx.ui.notify(`Session history import failed${message}`, "error");
      }
    } finally {
      // SQLite does not change data_version for this connection's own commits: https://www.sqlite.org/pragma.html#pragma_data_version
      databaseVersion = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      importSettled = undefined;
    }
  };

  const recordInput = (event: InputEvent, ctx: ExtensionContext) => {
    if (event.source === "interactive") {
      record(typedPrompt(event.text), ctx.ui);
    }
  };

  const recordBash = (event: UserBashEvent, ctx: ExtensionContext) => {
    record(bashPrompt(event.command, event.excludeFromContext), ctx.ui);
  };

  const dispose = async () => {
    closeSearch?.();
    session.abort();

    await importSettled;

    database?.close();
    database = undefined;
  };

  return { dispose, importHistory, open, recordBash, recordInput, start };
};
