import { acquireEditorHost } from "@clanker-stuff/editor";
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
  acquireEditorHost(ctx)?.seedHistory(seed.map(({ text }) => text));
};
