import { describe, expect, it, vi } from "vitest";

import {
  fetchXaiUsage,
  parseXaiMonthlyPayload,
  parseXaiUsagePayloads,
  parseXaiWeeklyPayload,
} from "../../adapters/xai.js";
import type { ProviderAuthClient } from "../../auth.js";
import type { FetchJson } from "../../http.js";

describe("xai monthly parsing", () => {
  it("computes remaining from used/monthlyLimit moneyish values", () => {
    const window = parseXaiMonthlyPayload({
      config: {
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
        monthlyLimit: { val: 100 },
        used: { val: 15 },
      },
    });
    expect(window).toStrictEqual({
      id: "month",
      label: "month",
      remainingPercent: 85,
      resetsAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("treats limit 0 with usage as 0% remaining", () => {
    expect(
      parseXaiMonthlyPayload({
        config: { monthlyLimit: 0, used: 5 },
      })?.remainingPercent
    ).toBe(0);
  });
});

describe("xai weekly parsing", () => {
  it("maps creditUsagePercent and prefers currentPeriod.end", () => {
    const window = parseXaiWeeklyPayload({
      config: {
        billingPeriodEnd: "2026-07-30T00:00:00.000Z",
        creditUsagePercent: 20,
        currentPeriod: {
          end: "2026-07-28T00:00:00.000Z",
          type: "USAGE_PERIOD_TYPE_WEEKLY",
        },
      },
    });
    expect(window).toStrictEqual({
      id: "week",
      label: "week",
      remainingPercent: 80,
      resetsAt: "2026-07-28T00:00:00.000Z",
    });
  });

  it("omits weekly usage when the percentage is missing", () => {
    expect(
      parseXaiWeeklyPayload({
        config: {
          billingPeriodEnd: "2026-07-28T00:00:00.000Z",
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        },
      })
    ).toBeUndefined();
  });

  it("rejects non-weekly typed periods", () => {
    expect(
      parseXaiWeeklyPayload({
        config: {
          creditUsagePercent: 10,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
        },
      })
    ).toBeUndefined();
  });
});

describe("xai combined payloads", () => {
  it("succeeds with monthly only when weekly is absent", () => {
    const result = parseXaiUsagePayloads(
      {
        config: {
          monthlyLimit: 100,
          used: 50,
        },
      },
      undefined,
      1000
    );
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 1000,
        provider: "xai",
        windows: [{ id: "month", label: "month", remainingPercent: 50 }],
      },
    });
  });

  it("maps prepaidBalance from the credits payload", () => {
    const result = parseXaiUsagePayloads(
      {
        config: {
          monthlyLimit: 22_000,
          used: 5614,
        },
      },
      {
        config: {
          creditUsagePercent: 100,
          currentPeriod: {
            end: "2026-07-24T19:36:06.507Z",
            type: "USAGE_PERIOD_TYPE_WEEKLY",
          },
          prepaidBalance: { val: 1084 },
        },
      },
      1000
    );
    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.creditsRemaining).toBe(1084);
    expect(
      result.snapshot.windows.find((window) => window.id === "week")
        ?.remainingPercent
    ).toBe(0);
  });
});

describe("xai fetch", () => {
  it("does not call billing for non-OAuth credentials", async () => {
    const authClient: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "sk-test" },
        source: "XAI_API_KEY",
      }),
    };
    const fetchJson = vi.fn<FetchJson>();
    const result = await fetchXaiUsage({
      authClient,
      fetchJson,
      now: () => 1,
    });
    expect(result).toStrictEqual({
      error: {
        kind: "unavailable",
        message: "subscription usage requires OAuth login (not API key)",
      },
      ok: false,
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("keeps monthly success when weekly request fails", async () => {
    const authClient: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "oauth-token" },
        source: "OAuth",
      }),
    };
    const fetchJson = vi.fn<FetchJson>(async (url) => {
      if (url.includes("format=credits")) {
        return { message: "HTTP 500", ok: false };
      }
      return {
        json: {
          config: {
            monthlyLimit: 200,
            used: 50,
          },
        },
        ok: true,
      };
    });

    const result = await fetchXaiUsage({
      authClient,
      fetchJson,
      now: () => 9,
    });
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 9,
        provider: "xai",
        windows: [{ id: "month", label: "month", remainingPercent: 75 }],
      },
    });
  });

  it("starts independent billing requests concurrently", async () => {
    const monthlyGate = Promise.withResolvers<null>();
    const authClient: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "oauth-token" },
        source: "OAuth",
      }),
    };
    const fetchJson = vi.fn<FetchJson>(async (url) => {
      if (!url.includes("format=credits")) {
        await monthlyGate.promise;
      }
      return {
        json: { config: { monthlyLimit: 100, used: 0 } },
        ok: true,
      };
    });

    const result = fetchXaiUsage({ authClient, fetchJson, now: () => 1 });
    await vi.waitFor(() => {
      expect(fetchJson).toHaveBeenCalledTimes(2);
    });
    monthlyGate.resolve(null);

    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it("returns a monthly failure without waiting for credits", async () => {
    const creditsGate = Promise.withResolvers<never>();
    const authClient: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "oauth-token" },
        source: "OAuth",
      }),
    };
    const fetchJson = vi.fn<FetchJson>(async (url) => {
      if (url.includes("format=credits")) {
        return creditsGate.promise;
      }
      return { message: "HTTP 500", ok: false };
    });

    const result = await fetchXaiUsage({ authClient, fetchJson, now: () => 1 });

    expect(result).toStrictEqual({
      error: { kind: "failure", message: "HTTP 500" },
      ok: false,
    });
    creditsGate.reject(new Error("credits failed after monthly returned"));
  });
});
