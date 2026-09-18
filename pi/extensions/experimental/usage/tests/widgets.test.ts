import { describe, expect, it } from "vite-plus/test";

import type { UsageSnapshot } from "../providers.js";
import { activeSnapshot, detailsSnapshot, fallbackText } from "../widgets.js";

const snapshot: UsageSnapshot = {
  fetchedAt: 1000,
  provider: "openai-codex",
  ordinaryUsageAllowed: false,
  windows: [
    { id: "5h", label: "5h", remainingPercent: 80 },
    { id: "7d", label: "7d", remainingPercent: 90, resetsAt: new Date(86_401_000).toISOString() },
  ],
};

describe("usage widgets", () => {
  it("shows the most-used ordinary window as active and the rest in details", () => {
    const presentation = { kind: "ready" as const, snapshot };
    const active = JSON.stringify(activeSnapshot(presentation, 1000).content);
    expect(active).toContain("20%");
    expect(active).not.toContain("7d");
    expect(active).toContain("ordinary usage unavailable");
    const details = JSON.stringify(detailsSnapshot(presentation, 1000).content);
    expect(details).toContain("7d 10% 1d");
    expect(details).not.toContain("5h");
    expect(fallbackText(presentation)).toContain("20% ordinary unavailable");
  });

  it("selects the weekly window when it is more used", () => {
    const presentation = {
      kind: "ready" as const,
      snapshot: {
        ...snapshot,
        windows: [
          { id: "5h" as const, label: "5h", remainingPercent: 90 },
          { id: "7d" as const, label: "7d", remainingPercent: 80 },
        ],
      },
    };

    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain("Codex 7d");
    expect(detailsSnapshot(presentation, 1000).content).toStrictEqual([
      { text: "5h 10%", tone: "text" },
    ]);
  });

  it("leaves details empty when there is only one ordinary window", () => {
    const presentation = {
      kind: "ready" as const,
      snapshot: { ...snapshot, windows: snapshot.windows.slice(0, 1) },
    };

    expect(detailsSnapshot(presentation, 1000).content).toStrictEqual([]);
    expect(detailsSnapshot(presentation, 1000).defaults).toStrictEqual({ enabled: false });
  });

  it("shows explicit eligibility without inventing a zero usage window", () => {
    const presentation = { kind: "ready" as const, snapshot: { ...snapshot, windows: [] } };
    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain(
      "ordinary usage unavailable",
    );
    expect(fallbackText(presentation)).toBe("usage Codex ordinary unavailable");
    expect(detailsSnapshot(presentation, 1000).content).toStrictEqual([]);
    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).not.toContain("0%");
  });
});
