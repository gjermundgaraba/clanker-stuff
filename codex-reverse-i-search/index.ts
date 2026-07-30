import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
} from "@earendil-works/pi-tui";

const WIDGET_KEY = "codex-reverse-i-search";

interface HistoryItem {
  text: string;
  timestamp: number;
}

interface SearchSession {
  draft: string;
  matches: string[];
  query: string;
  selected: number;
  ui: ExtensionContext["ui"];
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
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("");
  } else if (message.role === "bashExecution") {
    text = `${message.excludeFromContext ? "!!" : "!"}${message.command}`;
  }

  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  return {
    text: trimmed,
    timestamp: message.timestamp ?? Date.parse(entry.timestamp),
  };
};

const historyFromEntries = (entries: SessionEntry[]): HistoryItem[] =>
  entries.flatMap((entry) => {
    const item = textFromEntry(entry);
    return item ? [item] : [];
  });

const normalizeHistory = (items: HistoryItem[]): HistoryItem[] => {
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

const loadPersistentHistory = async (): Promise<HistoryItem[]> => {
  const sessions = await SessionManager.listAll();
  const history: HistoryItem[] = [];

  for (const session of sessions) {
    // oxlint-disable-next-line no-await-in-loop -- yielding between files keeps the TUI responsive
    await yieldToEventLoop();
    try {
      history.push(
        ...historyFromEntries(SessionManager.open(session.path).getEntries())
      );
    } catch {
      // A concurrently deleted or malformed session should not disable search.
    }
  }

  return history;
};

const printableText = (data: string): string | undefined => {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) {
    return kitty;
  }

  const pasteStart = "\u001B[200~";
  const pasteEnd = "\u001B[201~";
  const paste =
    data.startsWith(pasteStart) && data.endsWith(pasteEnd)
      ? data.slice(pasteStart.length, -pasteEnd.length)
      : undefined;
  const text = paste ?? data;
  if (paste === undefined && text.includes("\u001B")) {
    return undefined;
  }

  const printable = text.replaceAll(/\p{Cc}/gu, "");
  return printable || undefined;
};

export default function codexReverseISearch(pi: ExtensionAPI) {
  let history: HistoryItem[] = [];
  let historyLoading = false;
  let search: SearchSession | undefined;
  let unsubscribeInput: (() => void) | undefined;

  const renderSearch = () => {
    if (!search) {
      return;
    }

    const { ui } = search;
    let suffix = "";
    if (search.matches.length > 0) {
      suffix = ui.theme.fg("dim", "  enter accept · esc cancel");
    } else if (search.query && historyLoading) {
      suffix = ui.theme.fg("dim", "  searching");
    } else if (search.query) {
      suffix = ui.theme.fg("error", "  no match");
    }

    ui.setWidget(
      WIDGET_KEY,
      [`reverse-i-search: ${ui.theme.fg("accent", search.query)}${suffix}`],
      { placement: "belowEditor" }
    );
  };

  const refreshSearch = (preserveSelection = false) => {
    if (!search) {
      return;
    }

    const selectedText = preserveSelection
      ? search.matches[search.selected]
      : undefined;
    const query = search.query.toLowerCase();
    search.matches = query
      ? history
          .filter(({ text }) => text.toLowerCase().includes(query))
          .map(({ text }) => text)
      : [];
    search.selected =
      selectedText === undefined
        ? 0
        : Math.max(0, search.matches.indexOf(selectedText));
    search.ui.setEditorText(search.matches[search.selected] ?? search.draft);
    renderSearch();
  };

  const addHistory = (text: string, timestamp = Date.now()) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    history = [
      { text: trimmed, timestamp },
      ...history.filter((item) => item.text !== trimmed),
    ];
  };

  const moveSelection = (direction: 1 | -1) => {
    if (!search || search.matches.length === 0) {
      return;
    }

    search.selected = Math.max(
      0,
      Math.min(search.matches.length - 1, search.selected + direction)
    );
    search.ui.setEditorText(search.matches[search.selected] ?? search.draft);
    renderSearch();
  };

  const closeSearch = (restoreDraft: boolean) => {
    if (!search) {
      return;
    }
    if (restoreDraft) {
      search.ui.setEditorText(search.draft);
    }
    search.ui.setWidget(WIDGET_KEY, undefined);
    search = undefined;
  };

  const beginSearch = (ui: ExtensionContext["ui"]) => {
    if (search) {
      moveSelection(1);
      return;
    }
    search = {
      draft: ui.getEditorText(),
      matches: [],
      query: "",
      selected: 0,
      ui,
    };
    renderSearch();
  };

  const handleSearchInput: TerminalInputHandler = (data) => {
    if (!search) {
      return;
    }
    if (isKeyRelease(data)) {
      return { consume: true };
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      closeSearch(true);
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      if (search.matches.length > 0) {
        closeSearch(false);
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+r") || matchesKey(data, "up")) {
      moveSelection(1);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+s") || matchesKey(data, "down")) {
      moveSelection(-1);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+u")) {
      search.query = "";
      refreshSearch();
      return { consume: true };
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
      search.query = [...search.query].slice(0, -1).join("");
      refreshSearch();
      return { consume: true };
    }

    const printable = printableText(data);
    if (printable !== undefined) {
      search.query += printable;
      refreshSearch();
    }
    return { consume: true };
  };

  pi.registerShortcut("ctrl+r", {
    description: "Search prompt history",
    handler: (ctx) => {
      if (ctx.mode === "tui") {
        beginSearch(ctx.ui);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }

    history = normalizeHistory(
      historyFromEntries(ctx.sessionManager.getBranch())
    );
    historyLoading = true;
    unsubscribeInput = ctx.ui.onTerminalInput(handleSearchInput);

    void (async () => {
      let persistentHistory: HistoryItem[] = [];
      try {
        persistentHistory = await loadPersistentHistory();
      } catch {
        // Current-session history remains usable when global discovery fails.
      }
      history = normalizeHistory([...history, ...persistentHistory]);
      historyLoading = false;
      refreshSearch(true);
    })();
  });

  pi.on("input", (event) => {
    if (event.source === "interactive") {
      addHistory(event.text);
    }
  });

  pi.on("user_bash", (event) => {
    addHistory(`${event.excludeFromContext ? "!!" : "!"}${event.command}`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribeInput?.();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    search = undefined;
  });
}
