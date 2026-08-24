import { describe, expect, it } from "vite-plus/test";

import { formatDetail, formatProviderError, formatResetDuration } from "../format.js";
import type { UsageSnapshot } from "../providers.js";

const now = Date.parse("2026-07-21T12:00:00.000Z");

const codexSnapshot = (): UsageSnapshot => ({
  creditsRemaining: 12.5,
  fetchedAt: now,
  planLabel: "plus",
  provider: "openai-codex",
  windows: [
    {
      id: "5h",
      label: "5h",
      remainingPercent: 68.4,
      resetsAt: new Date(now + 2 * 3_600_000).toISOString(),
    },
    {
      id: "7d",
      label: "7d",
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

describe("detail formatting", () => {
  it("includes plan, windows, resets, and credits", () => {
    const text = formatDetail(codexSnapshot(), now);
    expect(text).toContain("Codex (plus)");
    expect(text).toContain("5h  68% left  resets in 2h");
    expect(text).toContain("7d  66% left  resets in 3d");
    expect(text).toContain("credits  12.5");
  });

  it("strips terminal controls from provider-controlled text", () => {
    const snapshot = codexSnapshot();
    snapshot.planLabel = "plus\nforged\tlabel\u001B]52;c;secret\u0007";
    const [firstWindow] = snapshot.windows;
    if (!firstWindow) {
      throw new Error("expected usage window");
    }
    firstWindow.label = "5h\nforged\twindow\u009B";

    const detail = formatDetail(snapshot, now);
    const error = formatProviderError(
      "openai-codex",
      "bad\nforged\terror\u001B]8;;https://secret\u0007link",
    );

    expect(`${detail}\n${error}`).not.toContain("\u001B");
    expect(`${detail}\n${error}`).not.toContain("\u009B");
    expect(detail.split("\n")).toHaveLength(4);
    expect(error).not.toContain("\n");
    expect(`${detail}\n${error}`).not.toContain("\t");
  });
});
