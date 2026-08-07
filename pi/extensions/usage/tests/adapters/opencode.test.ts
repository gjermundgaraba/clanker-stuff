import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseCodexBarHistory,
  runCodexBarUsage,
} from "../../adapters/opencode.js";

interface HistoryEntryFixture {
  capturedAt: string;
  resetsAt?: string;
  usedPercent: number;
}

interface HistoryWindowFixture {
  entries: HistoryEntryFixture[];
  name: string;
}

const window = (
  name: string,
  entries: HistoryEntryFixture[]
): HistoryWindowFixture => ({ entries, name });

const sampleHistory = (overrides?: {
  monthly?: HistoryEntryFixture[];
  session?: HistoryEntryFixture[];
  weekly?: HistoryEntryFixture[];
}): unknown => ({
  unscoped: [
    window(
      "session",
      overrides?.session ?? [
        {
          capturedAt: "2026-08-06T22:11:01Z",
          resetsAt: "2026-08-07T03:11:00Z",
          usedPercent: 0,
        },
      ]
    ),
    window(
      "weekly",
      overrides?.weekly ?? [
        {
          capturedAt: "2026-08-06T22:11:01Z",
          resetsAt: "2026-08-10T00:00:00Z",
          usedPercent: 100,
        },
      ]
    ),
    window(
      "monthly",
      overrides?.monthly ?? [
        {
          capturedAt: "2026-08-06T22:11:01Z",
          resetsAt: "2026-08-27T21:13:10Z",
          usedPercent: 80,
        },
      ]
    ),
  ],
});

const accountsHistory = (
  accountKey: string,
  windows: HistoryWindowFixture[],
  preferred?: string
): unknown => ({
  accounts: { [accountKey]: windows },
  preferredAccountKey: preferred ?? accountKey,
  unscoped: [],
});

const NOW = Date.parse("2026-08-06T22:30:00Z");

describe("codexbar history parsing", () => {
  it("maps session, weekly, and monthly windows from latest entries", () => {
    const result = parseCodexBarHistory(sampleHistory(), NOW);

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "opencode-go",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 100,
            resetsAt: "2026-08-07T03:11:00.000Z",
          },
          {
            id: "7d",
            label: "7d",
            remainingPercent: 0,
            resetsAt: "2026-08-10T00:00:00.000Z",
          },
          {
            id: "month",
            label: "month",
            remainingPercent: 20,
            resetsAt: "2026-08-27T21:13:10.000Z",
          },
        ],
      },
    });
  });

  it("takes only the latest entry from each window", () => {
    const result = parseCodexBarHistory(
      sampleHistory({
        monthly: [
          {
            capturedAt: "2026-08-06T22:11:01Z",
            resetsAt: "2026-08-27T21:13:10Z",
            usedPercent: 80,
          },
        ],
        session: [
          { capturedAt: "2026-08-06T20:00:00Z", usedPercent: 50 },
          { capturedAt: "2026-08-06T21:00:00Z", usedPercent: 75 },
          {
            capturedAt: "2026-08-06T22:11:01Z",
            resetsAt: "2026-08-07T03:11:00Z",
            usedPercent: 90,
          },
        ],
        weekly: [
          {
            capturedAt: "2026-08-06T22:11:01Z",
            resetsAt: "2026-08-10T00:00:00Z",
            usedPercent: 100,
          },
        ],
      }),
      NOW
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "opencode-go",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 10,
            resetsAt: "2026-08-07T03:11:00.000Z",
          },
          {
            id: "7d",
            label: "7d",
            remainingPercent: 0,
            resetsAt: "2026-08-10T00:00:00.000Z",
          },
          {
            id: "month",
            label: "month",
            remainingPercent: 20,
            resetsAt: "2026-08-27T21:13:10.000Z",
          },
        ],
      },
    });
  });

  it("ignores windows with no entries", () => {
    const result = parseCodexBarHistory(sampleHistory({ weekly: [] }), NOW);

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.windows.map((w) => w.id)).toStrictEqual([
      "5h",
      "month",
    ]);
  });

  it("reads windows from accounts when unscoped is empty", () => {
    const result = parseCodexBarHistory(
      accountsHistory("acct-1", [
        window("session", [
          {
            capturedAt: "2026-08-06T22:11:01Z",
            resetsAt: "2026-08-07T03:11:00Z",
            usedPercent: 30,
          },
        ]),
        window("weekly", [
          {
            capturedAt: "2026-08-06T22:11:01Z",
            resetsAt: "2026-08-10T00:00:00Z",
            usedPercent: 60,
          },
        ]),
      ]),
      NOW
    );

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.windows).toHaveLength(2);
    expect(result.snapshot.windows.at(0)?.remainingPercent).toBe(70);
    expect(result.snapshot.windows.at(1)?.remainingPercent).toBe(40);
  });

  it("uses preferredAccountKey to select among multiple accounts", () => {
    const result = parseCodexBarHistory(
      accountsHistory(
        "acct-preferred",
        [
          window("session", [
            { capturedAt: "2026-08-06T22:11:01Z", usedPercent: 10 },
          ]),
        ],
        "acct-preferred"
      ),
      NOW
    );

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.windows.at(0)?.remainingPercent).toBe(90);
  });

  it("rejects malformed history structure", () => {
    expect(
      parseCodexBarHistory({ unscoped: "not-an-array" }, 1).ok
    ).toBeFalsy();
  });

  it("rejects non-object input", () => {
    expect(parseCodexBarHistory("not json", 1).ok).toBeFalsy();
    expect(parseCodexBarHistory(null, 1).ok).toBeFalsy();
    expect(parseCodexBarHistory(undefined, 1).ok).toBeFalsy();
  });

  it("returns unavailable when no windows have entries", () => {
    const result = parseCodexBarHistory({ unscoped: [] }, NOW);
    expect(result.ok).toBeFalsy();
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("unavailable");
  });

  it("returns unavailable when capturedAt is older than 2 hours", () => {
    const stale = Date.parse("2026-08-06T22:00:00Z");
    const now = stale + 3 * 60 * 60_000;
    const result = parseCodexBarHistory(
      sampleHistory({
        session: [{ capturedAt: "2026-08-06T22:00:00Z", usedPercent: 0 }],
      }),
      now
    );

    expect(result.ok).toBeFalsy();
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("unavailable");
  });

  it("accepts data captured within the staleness threshold", () => {
    const captured = Date.parse("2026-08-06T22:00:00Z");
    const now = captured + 90 * 60_000;
    const result = parseCodexBarHistory(
      sampleHistory({
        session: [{ capturedAt: "2026-08-06T22:00:00Z", usedPercent: 0 }],
      }),
      now
    );

    expect(result.ok).toBeTruthy();
  });
});

describe("reading codexbar history from disk", () => {
  it("returns unavailable when history file is missing", async () => {
    const result = await runCodexBarUsage({
      filePath: "/definitely/missing/opencodego.json",
      now: () => NOW,
    });

    expect(result).toStrictEqual({
      error: {
        kind: "unavailable",
        message:
          "CodexBar history not found (open CodexBar so it can fetch usage from the web)",
      },
      ok: false,
    });
  });

  it("reads and parses a history file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codexbar-history-"));
    const filePath = path.join(dir, "opencodego.json");
    await writeFile(filePath, JSON.stringify(sampleHistory()), "utf-8");

    const result = await runCodexBarUsage({ filePath, now: () => NOW });

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.provider).toBe("opencode-go");
    expect(result.snapshot.windows).toHaveLength(3);
    expect(result.snapshot.windows.at(1)?.remainingPercent).toBe(0);
  });

  it("returns failure for corrupt JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codexbar-history-"));
    const filePath = path.join(dir, "opencodego.json");
    await writeFile(filePath, "{ not valid json", "utf-8");

    const result = await runCodexBarUsage({ filePath, now: () => NOW });
    expect(result.ok).toBeFalsy();
  });
});
