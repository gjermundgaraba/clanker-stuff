import type { ExtensionContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

import type { HistoryItem } from "./history.js";

export const WIDGET_KEY = "codex-reverse-i-search";
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

interface SearchSession {
  draft: string;
  filteredQuery: string;
  matches: HistoryItem[];
  query: string;
  selected: number;
  ui: ExtensionContext["ui"];
}

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

export const createSearch = (getHistory: () => readonly HistoryItem[]) => {
  let session: SearchSession | undefined;

  const render = () => {
    if (!session) {
      return;
    }

    const { ui } = session;
    let suffix = "";
    if (session.matches.length > 0) {
      suffix = ui.theme.fg("dim", "  enter accept · esc cancel");
    } else if (session.query) {
      suffix = ui.theme.fg("error", "  no match");
    }

    ui.setWidget(
      WIDGET_KEY,
      [`reverse-i-search: ${ui.theme.fg("accent", session.query)}${suffix}`],
      { placement: "belowEditor" },
    );
  };

  const refresh = () => {
    if (!session) {
      return;
    }

    const query = session.query.toLowerCase();
    const canNarrow = session.filteredQuery.length > 0 && query.startsWith(session.filteredQuery);
    const candidates = canNarrow ? session.matches : getHistory();
    const pattern = session.query ? new RegExp(RegExp.escape(session.query), "iu") : undefined;
    session.matches = pattern ? candidates.filter(({ text }) => pattern.test(text)) : [];
    session.filteredQuery = query;
    session.selected = 0;
    session.ui.setEditorText(session.matches[session.selected]?.text ?? session.draft);
    render();
  };

  const moveSelection = (direction: 1 | -1) => {
    if (!session || session.matches.length === 0) {
      return;
    }

    session.selected = Math.max(
      0,
      Math.min(session.matches.length - 1, session.selected + direction),
    );
    session.ui.setEditorText(session.matches[session.selected]?.text ?? session.draft);
    render();
  };

  const close = (restoreDraft: boolean) => {
    if (!session) {
      return;
    }
    if (restoreDraft) {
      session.ui.setEditorText(session.draft);
    }
    session.ui.setWidget(WIDGET_KEY, undefined);
    session = undefined;
  };

  const begin = (ui: ExtensionContext["ui"]) => {
    if (session) {
      moveSelection(1);
      return;
    }

    session = {
      draft: ui.getEditorText(),
      filteredQuery: "",
      matches: [],
      query: "",
      selected: 0,
      ui,
    };
    render();
  };

  const handleInput: TerminalInputHandler = (data) => {
    if (!session) {
      return { consume: false };
    }
    if (isKeyRelease(data)) {
      return { consume: true };
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      close(true);
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      if (session.matches.length > 0) {
        close(false);
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
      session.query = "";
      refresh();
      return { consume: true };
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
      let lastGraphemeStart = 0;
      for (const grapheme of graphemeSegmenter.segment(session.query)) {
        lastGraphemeStart = grapheme.index;
      }
      session.query = session.query.slice(0, lastGraphemeStart);
      refresh();
      return { consume: true };
    }

    const printable = printableText(data);
    if (printable !== undefined) {
      session.query += printable;
      refresh();
    }
    return { consume: true };
  };

  return {
    begin,
    handleInput,
    isOpen: () => session !== undefined,
    reset: () => {
      close(true);
    },
  };
};
