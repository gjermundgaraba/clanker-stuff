import type { DatabaseSync } from "node:sqlite";

import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext, InputEvent, UserBashEvent } from "@earendil-works/pi-coding-agent";

import type { HistoryItem } from "./history.js";
import { importPersistentHistory } from "./import.js";
import {
  getDataVersion,
  loadHistory,
  openHistoryDatabase,
  openMemoryDatabase,
  saveHistoryItem,
} from "./storage.js";
import { createSearch } from "./search.js";

const STATUS_KEY = "history";

/** Native ↑/↓ recall holds this many of the most recent prompts. */
const RECALL_LIMIT = 100;

export const createHistoryRuntime = () => {
  let database: DatabaseSync | undefined;
  let persistent = false;
  // Search snapshot; own writes are mirrored, other processes' writes reload it.
  let history: HistoryItem[] = [];
  let databaseVersion: number | undefined;
  let closeSearch: (() => void) | undefined;
  let importAbort: AbortController | undefined;
  let importPromise: Promise<number> | undefined;
  let persistenceWarningShown = false;

  const warnPersistence = (ui: ExtensionContext["ui"], cause: unknown): void => {
    if (persistenceWarningShown) return;
    persistenceWarningShown = true;
    const message = cause instanceof Error ? `: ${cause.message}` : "";
    ui.notify(`Prompt history persistence is unavailable${message}`, "warning");
  };

  const start = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    if (ctx.sessionManager.getSessionDir() !== "") {
      try {
        database = openHistoryDatabase();
        persistent = true;
      } catch (error) {
        warnPersistence(ctx.ui, error);
      }
    }

    // --no-session, or an unavailable store, keeps this session's history in memory only.
    database ??= openMemoryDatabase();
    let recent: HistoryItem[] = [];

    try {
      recent = loadHistory(database, RECALL_LIMIT);
    } catch (error) {
      warnPersistence(ctx.ui, error);
    }

    acquireEditorHost(ctx)?.seedHistory(recent.map(({ text }) => text).toReversed());
  };

  const record = (text: string, ui: ExtensionContext["ui"]) => {
    const trimmed = text.trim();

    if (!database || !trimmed) return;
    const item = { text: trimmed, timestamp: Date.now() };
    history = [item, ...history.filter((entry) => entry.text !== trimmed)];

    try {
      saveHistoryItem(database, item);
    } catch (error) {
      warnPersistence(ui, error);
    }
  };

  const snapshot = (activeDatabase: DatabaseSync, ui: ExtensionContext["ui"]) => {
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
    if (!database) return;
    const items = snapshot(database, ctx.ui);

    const accepted = await ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => {
      closeSearch = () => done(undefined);

      return createSearch(items, theme, done);
    });

    closeSearch = undefined;

    if (accepted !== undefined) ctx.ui.setEditorText(accepted);
  };

  const importHistory = async (ctx: ExtensionContext) => {
    if (!database) return;

    if (!persistent) {
      ctx.ui.notify("Prompt history persistence is unavailable", "warning");

      return;
    }

    if (importPromise) {
      ctx.ui.notify("Session history import is already running.", "warning");

      return;
    }

    const abort = new AbortController();
    importAbort = abort;
    importPromise = importPersistentHistory(
      database,
      ctx.sessionManager.getSessionDir(),
      (status) => ctx.ui.setStatus(STATUS_KEY, status),
      abort.signal,
    );

    try {
      const files = await importPromise;
      ctx.ui.notify(`Imported prompt history from ${files} session files.`, "info");
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? `: ${error.message}` : "";
        ctx.ui.notify(`Session history import failed${message}`, "error");
      }
    } finally {
      // Writes on this connection do not change its data version.
      databaseVersion = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      importAbort = undefined;
      importPromise = undefined;
    }
  };

  const recordInput = (event: InputEvent, ctx: ExtensionContext) => {
    if (event.source === "interactive") record(event.text, ctx.ui);
  };

  const recordBash = (event: UserBashEvent, ctx: ExtensionContext) => {
    record(`${event.excludeFromContext ? "!!" : "!"}${event.command}`, ctx.ui);
  };

  const dispose = async () => {
    closeSearch?.();
    importAbort?.abort();

    try {
      await importPromise;
    } catch {
      // The import command reports its errors; shutdown only waits for it to stop writing.
    }

    database?.close();
    database = undefined;
    persistent = false;
    history = [];
    databaseVersion = undefined;
    persistenceWarningShown = false;
  };

  return { dispose, importHistory, open, recordBash, recordInput, start };
};
