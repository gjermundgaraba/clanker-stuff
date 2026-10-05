import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  getKeybindings,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import type { HistoryItem } from "./history.js";

const PASTE_START = "\u001B[200~";

const PASTE_END = "\u001B[201~";

const PREVIEW_LINES = 8;

/** Columns the query keeps on the search line; the key hint is cut to fit what remains. */
const MIN_QUERY_WIDTH = 20;

/**
 * Ctrl+R search over a history snapshot, shown in place of the editor until `done` receives the
 * accepted prompt or undefined. The draft stays untouched while searching.
 */
export const createSearch = (
  history: readonly HistoryItem[],
  theme: Theme,
  done: (text: string | undefined) => void,
): Component & Focusable => {
  const input = new Input({ prompt: "history: " });
  let matches: readonly HistoryItem[] = [];
  let selected = 0;

  const edit = (data: string) => {
    const previous = input.getValue();
    input.handleInput(data);
    const query = input.getValue();

    if (query === previous) return;
    const pattern = new RegExp(RegExp.escape(query), "iu");
    matches = query ? history.filter(({ text }) => pattern.test(text)) : [];
    selected = 0;
  };

  const move = (direction: 1 | -1) => {
    selected = Math.max(0, Math.min(matches.length - 1, selected + direction));
  };

  const hint = () => {
    const bindings = getKeybindings();
    const accept = bindings.getKeys("tui.input.submit").join("/");
    const cancel = [...new Set([...bindings.getKeys("tui.select.cancel"), "ctrl+c"])].join("/");
    const actions = [accept ? `${accept} accept` : "", `${cancel} cancel`].filter(Boolean);

    if (matches.length > 0)
      return theme.fg("dim", `  ${selected + 1}/${matches.length} · ${actions.join(" · ")}`);

    return input.getValue() ? theme.fg("error", "  no match") : "";
  };

  const preview = (width: number) => {
    const lines = matches[selected]?.text.split("\n") ?? [];
    const hidden = lines.length - PREVIEW_LINES;

    const rows = [
      ...lines.slice(0, PREVIEW_LINES),
      ...(hidden > 0 ? [`… ${hidden} more lines`] : []),
    ];

    // Stored and imported history is arbitrary text; terminal controls in it must not reach the screen.
    return rows.map((row) => theme.fg("dim", truncateToWidth(displayText(row), width)));
  };

  return {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    render: (width) => {
      const suffix = truncateToWidth(hint(), Math.max(0, width - MIN_QUERY_WIDTH), "");

      return [
        theme.fg("accent", input.render(width - visibleWidth(suffix)).join("")) + suffix,
        ...preview(width),
      ];
    },
    handleInput: (data) => {
      // Pi delivers each bracketed paste as one packet. Input keeps pasted control characters.
      if (data.startsWith(PASTE_START)) {
        const text = data.slice(PASTE_START.length, -PASTE_END.length);
        edit(PASTE_START + text.replaceAll(/\p{Cc}/gu, "") + PASTE_END);

        return;
      }

      if (isKeyRelease(data)) return;
      const bindings = getKeybindings();

      if (bindings.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
        done(undefined);
      } else if (bindings.matches(data, "tui.input.submit") || data === "\n") {
        const match = matches[selected];

        if (match) done(match.text);
      } else if (matchesKey(data, "ctrl+r") || bindings.matches(data, "tui.select.up")) {
        move(1);
      } else if (matchesKey(data, "ctrl+s") || bindings.matches(data, "tui.select.down")) {
        move(-1);
      } else {
        edit(data);
      }
    },
    invalidate: () => input.invalidate(),
  };
};
