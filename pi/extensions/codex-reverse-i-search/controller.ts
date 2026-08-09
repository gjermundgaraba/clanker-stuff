import type { DatabaseSync } from "node:sqlite";

import type {
  ExtensionContext,
  InputEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";

import type { HistoryItem } from "./history.js";
import {
  getDataVersion,
  historyFromEntries,
  importPersistentHistory,
  loadHistory,
  normalizeHistory,
  openHistoryDatabase,
  saveHistoryBatch,
  saveHistoryItem,
} from "./history.js";
import { createSearch, WIDGET_KEY } from "./search.js";

export const createReverseSearch = () => {
  let database: DatabaseSync | undefined;
  let databaseVersion: number | undefined;
  let history: HistoryItem[] = [];
  let importPromise: Promise<number> | undefined;
  let persistenceWarningShown = false;
  let unsubscribeInput: (() => void) | undefined;

  const search = createSearch(() => history);

  const warnPersistence = (
    ui: ExtensionContext["ui"],
    error: unknown
  ): void => {
    if (persistenceWarningShown) {
      return;
    }
    persistenceWarningShown = true;
    const message = error instanceof Error ? `: ${error.message}` : "";
    ui.notify(`Prompt history persistence is unavailable${message}`, "warning");
  };

  const refreshHistory = (ui: ExtensionContext["ui"]) => {
    if (!database) {
      return;
    }
    try {
      const nextVersion = getDataVersion(database);
      if (nextVersion !== databaseVersion) {
        history = loadHistory(database);
        databaseVersion = nextVersion;
      }
    } catch (error) {
      warnPersistence(ui, error);
    }
  };

  const addHistory = (text: string, ui: ExtensionContext["ui"]) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const item = {
      text: trimmed,
      timestamp: Date.now(),
    };
    history = [item, ...history.filter((entry) => entry.text !== trimmed)];

    if (database) {
      try {
        saveHistoryItem(database, item);
      } catch (error) {
        warnPersistence(ui, error);
      }
    }
  };

  const open = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      return;
    }
    if (!search.isOpen()) {
      refreshHistory(ctx.ui);
    }
    search.begin(ctx.ui);
  };

  const importHistory = async (ctx: ExtensionContext) => {
    const activeDatabase = database;
    if (!activeDatabase) {
      ctx.ui.notify("Prompt history persistence is unavailable", "warning");
      return;
    }
    if (importPromise) {
      ctx.ui.notify("Session history import is already running.", "warning");
      return;
    }

    const pendingImport = importPersistentHistory(
      activeDatabase,
      ctx.sessionManager.getSessionDir(),
      (status) => {
        ctx.ui.setStatus(WIDGET_KEY, status);
      }
    );
    importPromise = pendingImport;

    try {
      const files = await pendingImport;
      const nextVersion = getDataVersion(activeDatabase);
      history = loadHistory(activeDatabase);
      databaseVersion = nextVersion;
      ctx.ui.notify(
        `Imported ${history.length} history entries from ${files} session files.`,
        "info"
      );
    } catch (error) {
      const message = error instanceof Error ? `: ${error.message}` : "";
      ctx.ui.notify(`Session history import failed${message}`, "error");
    } finally {
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      importPromise = undefined;
    }
  };

  const start = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      return;
    }

    unsubscribeInput = ctx.ui.onTerminalInput(search.handleInput);
    history = normalizeHistory(
      historyFromEntries(ctx.sessionManager.getBranch())
    );

    try {
      database = openHistoryDatabase();
      saveHistoryBatch(database, history);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Keep current-session history usable even when SQLite cleanup fails.
      }
      database = undefined;
      warnPersistence(ctx.ui, error);
    }
  };

  const recordInput = (event: InputEvent, ctx: ExtensionContext) => {
    if (event.source === "interactive") {
      addHistory(event.text, ctx.ui);
    }
  };

  const recordBash = (event: UserBashEvent, ctx: ExtensionContext) => {
    addHistory(
      `${event.excludeFromContext ? "!!" : "!"}${event.command}`,
      ctx.ui
    );
  };

  const dispose = async (ctx: ExtensionContext) => {
    try {
      await importPromise;
    } catch {
      // The import command handles errors; shutdown only waits for cleanup.
    }

    unsubscribeInput?.();
    unsubscribeInput = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    search.reset();
    database?.close();
    database = undefined;
  };

  return {
    dispose,
    importHistory,
    open,
    recordBash,
    recordInput,
    start,
  };
};
