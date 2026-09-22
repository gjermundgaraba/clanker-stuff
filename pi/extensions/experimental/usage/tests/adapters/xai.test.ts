import { okFetch } from "./helpers.js";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  fetchXaiUsage,
  mapXaiMonthlyPayload,
  mapXaiUsagePayloads,
  mapXaiWeeklyPayload,
} from "../../adapters/xai.js";
import type { ProviderAuthClient } from "../../auth.js";
import type { FetchJson } from "../../http.js";
import { defaultFetchJson } from "../../http.js";

describe("xai monthly parsing", () => {
  it("computes remaining from used/monthlyLimit moneyish values", () => {
    const window = mapXaiMonthlyPayload({
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
      mapXaiMonthlyPayload({
        config: { monthlyLimit: 0, used: 5 },
      })?.remainingPercent,
    ).toBe(0);
  });
});

describe("xai weekly parsing", () => {
  it("maps creditUsagePercent and prefers currentPeriod.end", () => {
    const window = mapXaiWeeklyPayload({
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
      mapXaiWeeklyPayload({
        config: {
          billingPeriodEnd: "2026-07-28T00:00:00.000Z",
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects non-weekly typed periods", () => {
    expect(
      mapXaiWeeklyPayload({
        config: {
          creditUsagePercent: 10,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("xai combined payloads", () => {
  it("maps prepaidBalance from the credits payload", () => {
    const result = mapXaiUsagePayloads(
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
      1000,
    );

    expect(result.ok).toBeTruthy();

    if (!result.ok) {
      return;
    }

    expect(result.snapshot.accounting?.available).toBe(1084);
    expect(
      result.snapshot.quotaWindows.find((window) => window.id === "week")?.remainingPercent,
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

    const client = { fetchJson: okFetch(undefined) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchXaiUsage({
      authClient,
      fetchJson: client.fetchJson,
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

    const client = {
      fetchJson: async (url, schema, options) => {
        if (url.includes("format=credits")) {
          return { kind: "response", message: "HTTP 500", ok: false };
        }

        return okFetch({
          config: {
            monthlyLimit: 200,
            used: 50,
          },
        })(url, schema, options);
      },
    } satisfies { fetchJson: FetchJson };

    const result = await fetchXaiUsage({
      authClient,
      fetchJson: client.fetchJson,
      now: () => 9,
    });

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 9,
        provider: "xai",
        quotaWindows: [{ id: "month", label: "month", remainingPercent: 75 }],
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

    const client = {
      fetchJson: async (url, schema, options) => {
        if (!url.includes("format=credits")) {
          await monthlyGate.promise;
        }

        return okFetch({ config: { monthlyLimit: 100, used: 0 } })(url, schema, options);
      },
    } satisfies { fetchJson: FetchJson };

    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = fetchXaiUsage({ authClient, fetchJson: client.fetchJson, now: () => 1 });
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

    const client = {
      fetchJson: async (url) => {
        if (url.includes("format=credits")) {
          return creditsGate.promise;
        }

        return { kind: "response", message: "HTTP 500", ok: false };
      },
    } satisfies { fetchJson: FetchJson };

    const result = await fetchXaiUsage({ authClient, fetchJson: client.fetchJson, now: () => 1 });

    expect(result).toStrictEqual({
      error: { kind: "failure", message: "HTTP 500" },
      ok: false,
    });
    creditsGate.reject(new Error("credits failed after monthly returned"));
  });
});

describe("xai optional payload boundaries", () => {
  it.each([200, 204])(
    "retains weekly usage after an empty monthly HTTP %i response",
    async (status) => {
      vi.stubGlobal("fetch", async (url: string) =>
        url.includes("format=credits")
          ? Response.json({ config: { creditUsagePercent: 20, prepaidBalance: { val: 10 } } })
          : new Response(null, { status }),
      );

      try {
        const result = await fetchXaiUsage({
          authClient: {
            getProviderAuth: async () => ({ auth: { apiKey: "token" }, source: "OAuth" }),
          },
          fetchJson: defaultFetchJson,
          now: () => 1,
        });

        expect(result).toStrictEqual({
          ok: true,
          snapshot: {
            accounting: { available: 10, kind: "credit-balance" },
            fetchedAt: 1,
            provider: "xai",
            quotaWindows: [{ id: "week", label: "week", remainingPercent: 80 }],
          },
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    { monthly: null, weekly: { config: { creditUsagePercent: 20 } }, ids: ["week"] },
    { monthly: { config: { monthlyLimit: 100, used: 10 } }, weekly: null, ids: ["month"] },
    { monthly: { config: {} }, weekly: { config: { creditUsagePercent: 20 } }, ids: ["week"] },
  ])("maps available windows for $ids", async ({ monthly, weekly, ids }) => {
    const fetchJson: FetchJson = (url, schema, options) =>
      okFetch(url.includes("format=credits") ? weekly : monthly)(url, schema, options);

    const result = await fetchXaiUsage({
      authClient: { getProviderAuth: async () => ({ auth: { apiKey: "token" }, source: "OAuth" }) },
      fetchJson,
      now: () => 1,
    });

    expect(result.ok).toBe(true);

    if (result.ok) expect(result.snapshot.quotaWindows.map(({ id }) => id)).toStrictEqual(ids);
  });

  it("observes weekly rejection even when the monthly request rejects", async () => {
    const weekly = Promise.withResolvers<never>();

    const fetchJson: FetchJson = async (url) => {
      if (url.includes("format=credits")) return weekly.promise;
      throw new Error("monthly failed");
    };

    await expect(
      fetchXaiUsage({
        authClient: {
          getProviderAuth: async () => ({ auth: { apiKey: "token" }, source: "OAuth" }),
        },
        fetchJson,
      }),
    ).rejects.toThrow("monthly failed");
    weekly.reject(new Error("weekly failed"));
  });

  it("keeps valid monthly windows when weekly rejects", async () => {
    const fetchJson: FetchJson = async (url, schema, options) => {
      if (url.includes("format=credits")) throw new Error("weekly failed");

      return okFetch({ config: { monthlyLimit: 100, used: 0 } })(url, schema, options);
    };

    const result = await fetchXaiUsage({
      authClient: { getProviderAuth: async () => ({ auth: { apiKey: "token" }, source: "OAuth" }) },
      fetchJson,
    });

    expect(result).toMatchObject({
      ok: true,
      snapshot: { quotaWindows: [{ id: "month", remainingPercent: 100 }] },
    });
  });
});
