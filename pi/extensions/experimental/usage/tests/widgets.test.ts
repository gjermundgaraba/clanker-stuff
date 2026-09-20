import { Value } from "typebox/value";
import {
  FooterWidgetSnapshotSchema,
  MAX_FOOTER_CONTENT_SPANS,
} from "@clanker-stuff/footer-protocol";
import { describe, expect, it } from "vite-plus/test";

import type { UsageSnapshot } from "../providers.js";
import { activeSnapshot, detailsSnapshot, fallbackText } from "../widgets.js";

const snapshot: UsageSnapshot = {
  accounting: { available: 12.5, kind: "credit-balance" },
  fetchedAt: 1000,
  ordinaryUsageAllowed: false,
  provider: "openai-codex",
  quotaWindows: [
    { id: "5h", label: "5h", remainingPercent: 80 },
    {
      id: "7d",
      label: "7d",
      remainingPercent: 90,
      resetsAt: new Date(86_401_000).toISOString(),
    },
  ],
};

const ready = (value: UsageSnapshot) => ({ kind: "ready" as const, snapshot: value });

describe("usage widgets", () => {
  it("prefers quota and keeps accounting in details", () => {
    const presentation = ready(snapshot);
    const active = JSON.stringify(activeSnapshot(presentation, 1000).content);
    expect(active).toContain("20%");
    expect(active).toContain("ordinary usage unavailable");
    const details = JSON.stringify(detailsSnapshot(presentation, 1000).content);
    expect(details).toContain("7d 10% 1d");
    expect(details).toContain("12.5 credits");
    expect(fallbackText(presentation)).toContain("20% ordinary unavailable");
  });

  it("selects a later quota window when it is more used", () => {
    const presentation = ready({
      ...snapshot,
      quotaWindows: [
        { id: "5h", label: "5h", remainingPercent: 90 },
        { id: "7d", label: "7d", remainingPercent: 40 },
      ],
    });

    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain("7d");
    expect(fallbackText(presentation)).toContain("7d 60%");
  });

  it("omits details for one quota window without secondary information", () => {
    const presentation = ready({
      fetchedAt: 1000,
      provider: "anthropic",
      quotaWindows: [{ id: "5h", label: "5h", remainingPercent: 80 }],
    });

    expect(detailsSnapshot(presentation, 1000).content).toStrictEqual([]);
  });

  it("renders eligibility-only snapshots", () => {
    const presentation = ready({
      fetchedAt: 1000,
      ordinaryUsageAllowed: false,
      provider: "openai-codex",
      quotaWindows: [],
    });

    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain(
      "ordinary usage unavailable",
    );
    expect(fallbackText(presentation)).toBe("usage Codex ordinary usage unavailable");
  });

  it("uses Radius accounting as the active metric", () => {
    const presentation = ready({
      accounting: {
        available: 43.26,
        balance: 46.51,
        currentMonthSpend: 33.48,
        kind: "radius-billing",
        periodEndsAt: "2026-10-01T00:00:00.000Z",
        reserved: 3.25,
      },
      fetchedAt: 1000,
      provider: "radius",
      quotaWindows: [],
    });

    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain(
      "$43.26 available",
    );
    expect(JSON.stringify(detailsSnapshot(presentation, 1000).content)).toContain(
      "$33.48 month spend",
    );
    expect(fallbackText(presentation)).toBe("usage Radius $43.26 available");
  });

  it("warns for non-positive available balance", () => {
    const presentation = ready({
      accounting: {
        available: -1.5,
        balance: 0,
        currentMonthSpend: 1.5,
        kind: "radius-billing",
        periodEndsAt: "2026-10-01T00:00:00.000Z",
        reserved: 0,
      },
      fetchedAt: 1000,
      provider: "radius",
      quotaWindows: [],
    });

    expect(activeSnapshot(presentation, 1000).content).toContainEqual({
      text: "-$1.50 available",
      tone: "warning",
    });
  });

  it("keeps unavailable eligibility visible beside a credit balance", () => {
    const presentation = ready({
      accounting: { available: 12.5, kind: "credit-balance" },
      fetchedAt: 1000,
      ordinaryUsageAllowed: false,
      provider: "openai-codex",
      quotaWindows: [],
    });

    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain(
      "ordinary usage unavailable",
    );
    expect(fallbackText(presentation)).toBe("usage Codex 12.5 credits ordinary unavailable");
  });

  it("bounds details to the footer protocol limit", () => {
    const presentation = ready({
      fetchedAt: 1000,
      provider: "zai",
      quotaWindows: Array.from({ length: 40 }, (_, index) => ({
        id: "day" as const,
        label: `quota ${index}`,
        remainingPercent: index,
      })),
    });

    const details = detailsSnapshot(presentation, 1000);

    expect(details.content).toHaveLength(MAX_FOOTER_CONTENT_SPANS);
    expect(Value.Check(FooterWidgetSnapshotSchema, details)).toBe(true);
  });
});
