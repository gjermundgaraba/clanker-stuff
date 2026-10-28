import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import type { UsageSnapshot } from "../providers.js";
import { statusText } from "../status.js";

const tones: Pick<Theme, "fg"> = {
  fg: (tone, text) => (text ? `<${tone}:${text}>` : ""),
};

const plain = (text: string) => text.replaceAll(/<\w+:|>/gu, "");

const snapshot: UsageSnapshot = {
  fetchedAt: 1000,
  provider: "anthropic",
  quotaWindows: [
    { label: "5h", remainingPercent: 80 },
    {
      label: "week",
      remainingPercent: 10,
      resetsAt: new Date(86_401_000).toISOString(),
    },
  ],
};

const ready = (value: UsageSnapshot) => ({
  kind: "ready" as const,
  snapshot: value,
});

describe(statusText, () => {
  it("shows the most-used window with a toned meter and its reset", () => {
    const text = statusText(ready(snapshot), 1000, tones);

    expect(plain(text)).toBe("Claude week ━━━━━━━━━─ 90% · 1d");
    expect(text).toContain("<error: 90%>");
    expect(text).toContain("<dim:─>");
  });

  it("does not promote supplementary quotas when no main quota is reported", () => {
    const text = statusText(
      ready({
        provider: "openai-codex",
        fetchedAt: 1000,
        quotaWindows: [],
        additionalQuotaWindows: [{ label: "Spark 5h", remainingPercent: 0 }],
      }),
      1000,
      tones
    );

    expect(plain(text)).toBe("Codex account quota not reported");
  });

  it("marks stale data and stays quiet while loading or unavailable", () => {
    expect(statusText({ kind: "stale", snapshot }, 1000, tones)).toMatch(
      /<warning: !>$/u
    );
    expect(statusText({ kind: "loading", provider: "zai" }, 1000, tones)).toBe(
      "<dim:GLM usage loading>"
    );
    expect(statusText({ kind: "error", provider: "xai" }, 1000, tones)).toBe(
      "<muted:Grok usage unavailable>"
    );
  });

  it("uses accounting without inventing quota windows and warns at a non-positive balance", () => {
    const radius = (available: number) =>
      statusText(
        ready({
          accounting: {
            available,
            balance: 46.51,
            currentMonthSpend: 33.48,
            kind: "radius-billing",
            periodEndsAt: "2026-10-01T00:00:00.000Z",
            reserved: 3.25,
          },
          fetchedAt: 1000,
          provider: "radius",
          quotaWindows: [],
        }),
        1000,
        tones
      );

    expect(radius(43.26)).toBe("<muted:Radius ><text:$43.26 available>");
    expect(radius(-1.5)).toBe("<muted:Radius ><warning:-$1.50 available>");
    expect(
      plain(
        statusText(
          ready({
            accounting: { available: 12.5, kind: "credit-balance" },
            fetchedAt: 1000,
            provider: "openrouter",
            quotaWindows: [],
          }),
          1000,
          tones
        )
      )
    ).toBe("OpenRouter 12.5 credits");
  });

  it("strips terminal controls from provider quota labels", () => {
    const text = statusText(
      ready({
        fetchedAt: 1000,
        provider: "openai-codex",
        quotaWindows: [
          {
            label: "Spark\n15m\u001B]52;c;secret\u0007",
            remainingPercent: 20,
          },
        ],
      }),
      1000,
      tones
    );

    expect(plain(text)).toBe("Codex Spark 15m ━━━━━━━━── 80%");
  });

  it("strips terminal controls from provider plan labels", () => {
    const text = statusText(
      ready({
        ...snapshot,
        provider: "zai",
        planLabel: "Pro\u001B]52;c;x\u0007\u202E",
      }),
      1000,
      tones
    );

    expect(text).not.toContain("\u001B");
    expect(plain(text)).toMatch(/^GLM \(Pro\) week/u);
  });
});
