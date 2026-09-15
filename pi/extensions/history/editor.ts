import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

import { historyFromEntries, normalizeHistory, type HistoryItem } from "./history.js";

const initialHistory = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
  getPersistentHistory: () => readonly HistoryItem[],
): readonly HistoryItem[] => {
  const session = ctx.sessionManager;
  const fresh =
    event.reason !== "resume" &&
    event.reason !== "fork" &&
    !session.getHeader()?.parentSession &&
    !session
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" ||
          entry.type === "compaction" ||
          entry.type === "branch_summary",
      );

  if (fresh && session.getSessionDir() !== "") {
    return getPersistentHistory();
  }

  // On initial launch Pi populates the active editor after session_start.
  // Replacement sessions render before binding extensions; reload does not
  // repopulate history. Those paths need their branch seeded here instead.
  return event.reason === "startup"
    ? []
    : normalizeHistory(historyFromEntries(session.getBranch()));
};

export const installHistoryEditor = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
  getPersistentHistory: () => readonly HistoryItem[],
): void => {
  const seed = initialHistory(event, ctx, getPersistentHistory).slice(0, 100).toReversed();
  const previous = ctx.ui.getEditorComponent();
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor =
      previous?.(tui, theme, keybindings) ??
      new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });

    for (const { text } of seed) {
      editor.addToHistory?.(text);
    }
    return editor;
  });
};
