import { acquireEditorHost, type Preview } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  getKeybindings,
  setKeybindings,
  KeybindingsManager,
  type TUI,
  type TuiMainScreen,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { HistoryItem } from "./history.js";

export const WIDGET_KEY = "history";

const PASTE_START = "\u001B[200~";

const PASTE_END = "\u001B[201~";

const sanitize = (text: string) => text.replaceAll(/\p{Cc}/gu, "");

// Input exposes edits through key handling only. These bindings are used solely
// for the synchronous whole-query clear, independently of user remappings.
const clearBindings = new KeybindingsManager({
  "tui.editor.cursorLineEnd": { defaultKeys: "ctrl+e" },
  "tui.editor.deleteToLineStart": { defaultKeys: "ctrl+u" },
});

const clearQuery = (input: Input) => {
  if (!input.getValue()) return;
  const bindings = getKeybindings();

  try {
    setKeybindings(clearBindings);
    input.handleInput("\u0005");
    input.handleInput("\u0015");
  } finally {
    setKeybindings(bindings);
  }
};

/** Without the shared editor a preview owns only the text: no cursor, undo or modal restore. */
const textPreview = (ui: ExtensionContext["ui"]): Preview => {
  const draft = ui.getEditorText();
  let shown = draft;
  let active = true;
  // Another component's edit relinquishes ownership, as with the shared editor's revisions.
  const owned = () => (active &&= ui.getEditorText() === shown);

  return {
    show: (text) => {
      if (!owned()) return;
      ui.setEditorText(text);
      // Compare with what the editor actually stored: Pi normalizes tabs and line endings.
      shown = ui.getEditorText();
    },
    close: (cancel) => {
      if (owned() && cancel) ui.setEditorText(draft);
      active = false;
    },
  };
};

interface SearchSession {
  draft: string;
  transaction: Preview;
  filteredQuery: string;
  matches: HistoryItem[];
  input: Input;
  pasteBuffer: string | undefined;
  selected: number;
  requestRender?: () => void;
  ui: ExtensionContext["ui"];
}

export const createSearch = (getHistory: () => readonly HistoryItem[]) => {
  let session: SearchSession | undefined;

  const createWidget = (active: SearchSession, tui: TUI) => {
    const { ui, input } = active;
    // SAFETY: Pi v0.86.1 supplies one of these two concrete renderers. Both
    // expose this public getter, omitted from their shared TUI interface.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The pinned Pi renderers expose this focus getter, but their shared TUI declaration omits it; no private renderer state is accessed.
    const renderer = tui as TUI & Pick<TuiMainScreen, "getFocusedComponent">;
    const previousFocus = renderer.getFocusedComponent();

    const widget = {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;

        if (!value) active.pasteBuffer = undefined;
      },
      render: (width: number) => {
        const bindings = getKeybindings();
        const accept = bindings.getKeys("tui.input.submit").join("/");
        const cancel = [...new Set([...bindings.getKeys("tui.select.cancel"), "ctrl+c"])].join("/");

        const actions = [accept ? `${accept} accept` : "", `${cancel} cancel`]
          .filter(Boolean)
          .join(" · ");

        const suffix =
          active.matches.length > 0
            ? ui.theme.fg("dim", `  ${actions}`)
            : input.getValue()
              ? ui.theme.fg("error", "  no match")
              : "";

        const hint = truncateToWidth(suffix, Math.max(0, width - 20), "");

        return [ui.theme.fg("accent", input.render(width - visibleWidth(hint)).join("")) + hint];
      },
      handleInput: (data: string) => {
        if (session === active && input.focused) handleInput(data);
      },
      invalidate: () => input.invalidate(),
      dispose: () => {
        // Do not steal focus back from a dialog opened during the search.
        if (input.focused) tui.setFocus(previousFocus);
      },
    };

    active.requestRender = () => tui.requestRender();
    tui.setFocus(widget);

    return widget;
  };

  const showPreview = () => {
    if (!session) return;
    session.transaction.show(session.matches[session.selected]?.text ?? session.draft);
    session.requestRender?.();
  };

  const refresh = () => {
    if (!session) {
      return;
    }

    const query = session.input.getValue().toLowerCase();
    const canNarrow = session.filteredQuery.length > 0 && query.startsWith(session.filteredQuery);
    const candidates = canNarrow ? session.matches : getHistory();

    const pattern = session.input.getValue()
      ? new RegExp(RegExp.escape(session.input.getValue()), "iu")
      : undefined;

    session.matches = pattern ? candidates.filter(({ text }) => pattern.test(text)) : [];
    session.filteredQuery = query;
    session.selected = 0;
    showPreview();
  };

  const moveSelection = (direction: 1 | -1) => {
    if (!session || session.matches.length === 0) {
      return;
    }

    session.selected = Math.max(
      0,
      Math.min(session.matches.length - 1, session.selected + direction),
    );
    showPreview();
  };

  const close = (restoreDraft: boolean) => {
    if (!session) {
      return;
    }

    session.transaction.close(restoreDraft);
    session.ui.setWidget(WIDGET_KEY, undefined);
    session = undefined;
  };

  const begin = (ui: ExtensionContext["ui"]) => {
    if (session?.input.focused) {
      moveSelection(1);

      return;
    }

    // Discard the old query, but do not promote an unaccepted preview into
    // the next draft. close() restores only text still owned by that search.
    close(true);

    const draft = ui.getEditorText();
    session = {
      draft,
      transaction: acquireEditorHost({ ui })?.preview() ?? textPreview(ui),
      filteredQuery: "",
      matches: [],
      input: new Input({ prompt: "history: " }),
      pasteBuffer: undefined,
      selected: 0,
      ui,
    };
    const active = session;
    ui.setWidget(WIDGET_KEY, (tui) => createWidget(active, tui), { placement: "belowEditor" });
  };

  const editQuery = (data: string) => {
    if (!session) return;
    const previous = session.input.getValue();
    session.input.handleInput(data);

    if (session.input.getValue() !== previous) refresh();
    else session.requestRender?.();
  };

  const handleInput = (data: string): void => {
    if (!session) return;

    // Sanitize before Input records a paste in its value, undo stack or kill ring.
    // Buffer across chunks so pasted control keys cannot accept/cancel the search.
    if (session.pasteBuffer !== undefined || data.startsWith(PASTE_START)) {
      session.pasteBuffer = (session.pasteBuffer ?? "") + data;
      const end = session.pasteBuffer.indexOf(PASTE_END);

      if (end !== -1) {
        const text = session.pasteBuffer.slice(PASTE_START.length, end);
        const remaining = session.pasteBuffer.slice(end + PASTE_END.length);
        session.pasteBuffer = undefined;
        editQuery(PASTE_START + sanitize(text) + PASTE_END);

        if (remaining) handleInput(remaining);
      }

      return;
    }

    if (isKeyRelease(data)) {
      return;
    }

    const bindings = getKeybindings();

    if (bindings.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
      close(true);

      return;
    }

    if (bindings.matches(data, "tui.input.submit") || data === "\n") {
      if (session.matches.length > 0) {
        close(false);
      }

      return;
    }

    if (matchesKey(data, "ctrl+r") || matchesKey(data, "up")) {
      moveSelection(1);

      return;
    }

    if (matchesKey(data, "ctrl+s") || matchesKey(data, "down")) {
      moveSelection(-1);

      return;
    }

    if (matchesKey(data, "ctrl+u")) {
      clearQuery(session.input);
      refresh();

      return;
    }

    editQuery(data.includes("\u001B") || data.length === 1 ? data : sanitize(data));
  };

  return {
    begin,
    isActive: () => session?.input.focused ?? false,
    reset: () => {
      close(true);
    },
  };
};
