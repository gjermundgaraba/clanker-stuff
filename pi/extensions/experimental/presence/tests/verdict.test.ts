import { describe, expect, it } from "vite-plus/test";

import type { PresenceRecord } from "../record.js";
import { verdictOf } from "../verdict.js";

const NOW = 10_000_000;

const record = (patch: Partial<PresenceRecord> = {}): PresenceRecord => ({
  pid: 42,
  sessionId: "s1",
  name: "kiwi",
  cwd: "/work",
  startedAt: NOW - 60_000,
  updatedAt: NOW - 1000,
  activity: "idle",
  since: NOW - 30_000,
  parked: [],
  ...patch,
});

const wait = { source: "waits", id: "w_1", about: "a wait for the build" };

describe("a session's verdict", () => {
  it("is waiting on you when idle with nothing parked", () => {
    expect(verdictOf(record(), true, NOW).word).toBe("waiting");
  });

  it("is working when idle but parked on a wait or a reply", () => {
    const verdict = verdictOf(record({ parked: [wait] }), true, NOW);

    expect(verdict).toStrictEqual({
      word: "working",
      detail: "parked on a wait for the build",
    });
  });

  it("is working while its agent runs, parked or not", () => {
    expect(verdictOf(record({ activity: "busy" }), true, NOW).word).toBe(
      "working"
    );
    expect(
      verdictOf(
        record({ activity: "busy", tool: "bash", parked: [wait] }),
        true,
        NOW
      ).detail
    ).toBe("in the bash tool, since 30s ago");
  });

  it("is waiting on you while a dialog is open, even mid-run", () => {
    expect(
      verdictOf(record({ activity: "dialog", parked: [wait] }), true, NOW).word
    ).toBe("waiting");
  });

  it("is stopped when its process is gone, whatever it last reported", () => {
    for (const activity of ["idle", "busy", "dialog"] as const) {
      expect(
        verdictOf(record({ activity, parked: [wait] }), false, NOW).word
      ).toBe("stopped");
    }
  });

  it("is stopped after a clean quit, even if the pid was reused", () => {
    expect(verdictOf(record({ endedAt: NOW - 5000 }), true, NOW)).toStrictEqual(
      {
        word: "stopped",
        detail: "quit 5s ago",
      }
    );
  });
});
