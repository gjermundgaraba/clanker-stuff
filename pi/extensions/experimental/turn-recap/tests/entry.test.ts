import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { ENTRY_TYPE, restoreSnapshots } from "../entry.js";
import { snapshot } from "./fixtures.js";

describe("snapshot restoration", () => {
  it("folds updates, retains the last successful recap, and restores interrupted requests without retrying", () => {
    const session = SessionManager.inMemory();

    const first = {
      ...snapshot(),
      recap: { status: "ready" as const, text: "First", usage: snapshot().metrics.usage },
    };

    session.appendCustomEntry(ENTRY_TYPE, first);
    session.appendCustomEntry(ENTRY_TYPE, { ...first, recap: { ...first.recap, text: "Updated" } });
    session.appendCustomEntry(ENTRY_TYPE, {
      ...snapshot(),
      runId: "run-2",
      recap: { status: "pending" },
    });
    expect(restoreSnapshots(session.getBranch())).toMatchObject({
      current: { runId: "run-2", recap: { status: "cancelled" } },
      previousRecap: "Updated",
    });
  });

  it("ignores malformed, non-finite, and retired records", () => {
    const session = SessionManager.inMemory();
    session.appendCustomEntry("@clanker-stuff/recap", { completedTurns: 1, recap: "Old" });
    session.appendCustomEntry(ENTRY_TYPE, { ...snapshot(), activeMs: -1 });
    session.appendCustomEntry(ENTRY_TYPE, { ...snapshot(), activeMs: Infinity });
    session.appendCustomEntry(ENTRY_TYPE, { ...snapshot(), metrics: { extra: 1 } });
    expect(restoreSnapshots(session.getBranch()).current).toBeUndefined();
  });
});
