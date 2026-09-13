import { describe, expect, it } from "vite-plus/test";

import type { UsageSnapshot } from "../providers.js";
import { activeSnapshot, detailsSnapshot, fallbackText } from "../widgets.js";

const snapshot: UsageSnapshot = {
  fetchedAt: 1000,
  provider: "openai-codex",
  ordinaryUsageAllowed: false,
  windows: [{ id: "5h", label: "5h", remainingPercent: 80 }],
  additionalLimits: [
    {
      id: "a",
      label: "Extra",
      model: "model-a",
      windows: [{ id: "5h", label: "5h", remainingPercent: 1 }],
    },
    {
      id: "b",
      label: "Extra",
      model: "model-b",
      windows: [{ id: "5h", label: "5h", remainingPercent: 2 }],
    },
  ],
};

describe("usage widgets", () => {
  it("keeps the ordinary quota active while displaying distinct model quotas in details", () => {
    const presentation = { kind: "ready" as const, snapshot };
    const active = JSON.stringify(activeSnapshot(presentation, 1000).content);
    expect(active).toContain("20%");
    expect(active).not.toContain("99%");
    expect(active).toContain("ordinary usage unavailable");
    const details = JSON.stringify(detailsSnapshot(presentation, 1000).content);
    expect(details).toContain("Extra [a] (model-a) 5h 99%");
    expect(details).toContain("Extra [b] (model-b) 5h 98%");
    expect(fallbackText(presentation)).toContain("20% ordinary unavailable");
  });

  it("shows explicit eligibility without inventing a zero usage window", () => {
    const presentation = { kind: "ready" as const, snapshot: { ...snapshot, windows: [] } };
    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).toContain(
      "ordinary usage unavailable",
    );
    expect(fallbackText(presentation)).toBe("usage Codex ordinary unavailable");
    expect(JSON.stringify(activeSnapshot(presentation, 1000).content)).not.toContain("0%");
  });
});
