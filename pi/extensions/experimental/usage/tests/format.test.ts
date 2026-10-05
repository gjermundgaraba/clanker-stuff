import { describe, expect, it } from "vite-plus/test";

import {
  formatCredits,
  formatDetail,
  formatProviderError,
  formatResetDuration,
  formatUsd,
} from "../format.js";
import type { UsageSnapshot } from "../providers.js";

const now = Date.parse("2026-07-21T12:00:00.000Z");

const claudeSnapshot = (): UsageSnapshot => ({
  fetchedAt: now,
  planLabel: "plus",
  provider: "anthropic",
  quotaWindows: [
    {
      id: "5h",
      label: "5h",
      remainingPercent: 68.4,
      resetsAt: new Date(now + 2 * 3_600_000).toISOString(),
    },
    {
      id: "week",
      label: "week",
      remainingPercent: 66.1,
      resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
    },
  ],
});

describe("reset duration formatting", () => {
  it("formats compact durations", () => {
    expect(
      [
        new Date(now - 1000),
        new Date(now + 45 * 60_000),
        new Date(now + 2 * 3_600_000),
        new Date(now + 2 * 3_600_000 + 15 * 60_000),
        new Date(now + 3 * 86_400_000),
        new Date(now + 3 * 86_400_000 + 4 * 3_600_000),
      ].map((date) => formatResetDuration(date.toISOString(), now)),
    ).toStrictEqual(["now", "45m", "2h", "2h 15m", "3d", "3d 4h"]);
  });
});

describe("amount formatting", () => {
  it("uses standard USD and credit formatting", () => {
    expect([formatUsd(12.5), formatUsd(-1.5), formatUsd(0), formatCredits(12.5)]).toStrictEqual([
      "$12.50",
      "-$1.50",
      "$0.00",
      "12.5",
    ]);
  });
});

describe("detail formatting", () => {
  it("includes plan and quota reset times", () => {
    const snapshot = claudeSnapshot();
    const text = formatDetail(snapshot, now);
    expect(text).toContain("Claude (plus)");
    expect(text).toContain("5h  68% left  resets in 2h");
    expect(text).toContain("week  66% left  resets in 3d");
  });

  it("formats Radius accounting", () => {
    const text = formatDetail(
      {
        accounting: {
          available: 43.26,
          balance: 46.51,
          currentMonthSpend: 33.48,
          kind: "radius-billing",
          periodEndsAt: new Date(now + 3 * 86_400_000).toISOString(),
          reserved: 3.25,
        },
        fetchedAt: now,
        provider: "radius",
        quotaWindows: [],
      },
      now,
    );

    expect(text).toBe(
      "Radius\navailable  $43.26\nbalance  $46.51\nreserved  $3.25\nmonth spend  $33.48  ends in 3d",
    );
  });

  it("strips terminal controls from provider-controlled text", () => {
    const snapshot = claudeSnapshot();
    snapshot.planLabel = "plus\nforged\tlabel\u001B]52;c;secret\u0007";
    const firstWindow = snapshot.quotaWindows[0];

    if (firstWindow === undefined) throw new Error("expected usage window");
    firstWindow.label = "5h\nforged\twindow\u009B";

    const detail = formatDetail(snapshot, now);

    const error = formatProviderError(
      "anthropic",
      "bad\nforged\terror\u001B]8;;https://secret\u0007link",
    );

    expect(`${detail}\n${error}`).not.toContain("\u001B");
    expect(`${detail}\n${error}`).not.toContain("\u009B");
    expect(detail.split("\n")).toHaveLength(3);
    expect(error).not.toContain("\n");
    expect(`${detail}\n${error}`).not.toContain("\t");
  });
});
