import { okFetch, tokenAuthClient } from "./helpers.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { fetchCodexUsage, mapCodexUsagePayload } from "../../adapters/codex.js";
import type { ProviderAuthClient } from "../../auth.js";
import type { FetchJson } from "../../http.js";

const makeJwt = (accountId: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");

  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");

  return `${header}.${body}.sig`;
};

describe("codex payload parsing", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");

  it("maps primary/secondary windows, plan, and credits", () => {
    const result = mapCodexUsagePayload(
      {
        credits: { balance: 12.5, has_credits: true },
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            reset_after_seconds: 3600,
            used_percent: 32,
          },
          secondary_window: {
            reset_after_seconds: 7 * 86_400,
            used_percent: 34,
          },
        },
      },
      now,
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        accounting: { available: 12.5, kind: "credit-balance" },
        fetchedAt: now,
        planLabel: "plus",
        provider: "openai-codex",
        quotaWindows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 68,
            resetsAt: new Date(now + 3_600_000).toISOString(),
          },
          {
            id: "7d",
            label: "7d",
            remainingPercent: 66,
            resetsAt: new Date(now + 7 * 86_400_000).toISOString(),
          },
        ],
      },
    });
  });

  it("parses a string credit balance", () => {
    const result = mapCodexUsagePayload(
      {
        credits: { balance: "12.5", has_credits: true },
        rate_limit: {
          primary_window: { used_percent: 32 },
          secondary_window: null,
        },
      },
      now,
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        accounting: { available: 12.5, kind: "credit-balance" },
        fetchedAt: now,
        provider: "openai-codex",
        quotaWindows: [{ id: "5h", label: "5h", remainingPercent: 68 }],
      },
    });
  });

  it.each([null, undefined, "", "  ", "invalid", Infinity, NaN, "Infinity"])(
    "omits an unavailable credit balance (%s)",
    (balance) => {
      const result = mapCodexUsagePayload(
        {
          credits: { has_credits: true, ...(balance !== undefined ? { balance } : {}) },
          rate_limit: { primary_window: { used_percent: 0 } },
        },
        0,
      );

      expect(result).toMatchObject({ ok: true });

      if (!result.ok) throw new Error("Expected usage snapshot");
      expect(result.snapshot).not.toHaveProperty("accounting");
    },
  );

  it("accepts a null credit balance", () => {
    const result = mapCodexUsagePayload(
      {
        credits: { balance: null, has_credits: false },
        rate_limit: {
          primary_window: { used_percent: 32 },
          secondary_window: null,
        },
      },
      now,
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: now,
        provider: "openai-codex",
        quotaWindows: [{ id: "5h", label: "5h", remainingPercent: 68 }],
      },
    });
  });

  it("fails when windows are missing", () => {
    const result = mapCodexUsagePayload({ rate_limit: {} }, now);
    expect(result.ok).toBeFalsy();
  });

  it("labels team primary window as 7d from limit_window_seconds", () => {
    const result = mapCodexUsagePayload(
      {
        plan_type: "team",
        rate_limit: {
          primary_window: {
            limit_window_seconds: 604_800,
            reset_after_seconds: 600_000,
            used_percent: 0,
          },
          secondary_window: null,
        },
      },
      now,
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: now,
        planLabel: "team",
        provider: "openai-codex",
        quotaWindows: [
          {
            id: "7d",
            label: "7d",
            remainingPercent: 100,
            resetsAt: new Date(now + 600_000 * 1000).toISOString(),
          },
        ],
      },
    });
  });

  it("labels windows from limit_window_seconds when both slots present", () => {
    const result = mapCodexUsagePayload(
      {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            used_percent: 40,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            used_percent: 25,
          },
        },
      },
      now,
    );

    expect(result.ok).toBeTruthy();

    if (!result.ok) {
      return;
    }

    expect(result.snapshot.quotaWindows.map((window) => window.id)).toStrictEqual(["5h", "7d"]);
    expect(result.snapshot.quotaWindows.map((window) => window.remainingPercent)).toStrictEqual([
      60, 75,
    ]);
  });
});

describe("codex fetch", () => {
  it("rejects OAuth tokens without a ChatGPT account id", async () => {
    const client = { fetchJson: okFetch(undefined) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchCodexUsage({
      authClient: {
        getProviderAuth: async () => ({
          auth: { apiKey: "not-a-jwt" },
          source: "OAuth",
        }),
      },
      fetchJson: client.fetchJson,
      now: () => 1000,
    });

    expect(result).toStrictEqual({
      error: {
        kind: "failure",
        message: "missing ChatGPT account id in token",
      },
      ok: false,
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("sends bearer and account id headers", async () => {
    const token = makeJwt("acct_abc");

    const authClient: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: token },
        source: "OAuth",
      }),
    };

    const client = {
      fetchJson: okFetch({
        rate_limit: {
          primary_window: { used_percent: 10 },
        },
      }),
    } satisfies { fetchJson: FetchJson };

    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchCodexUsage({
      authClient,
      fetchJson: client.fetchJson,
      now: () => 1000,
    });

    expect(result.ok).toBeTruthy();
    const [url, , options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(options?.headers).toStrictEqual({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": "acct_abc",
    });
    expect(fetchJson).toHaveBeenCalledOnce();
  });
});

describe("Codex ordinary limits", () => {
  it("preserves eligibility-only responses and nullable fields", () => {
    expect(mapCodexUsagePayload({ rate_limit: { allowed: false } }, 1000)).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 1000,
        provider: "openai-codex",
        ordinaryUsageAllowed: false,
        quotaWindows: [],
      },
    });
    expect(mapCodexUsagePayload({ credits: null, rate_limit: null }, 1000).ok).toBe(false);
  });

  it.each(
    [
      [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_bengalfox",
          normal_model_slug: "gpt-5.3-codex-spark",
          rate_limit: {
            allowed: true,
            primary_window: { used_percent: 0, reset_after_seconds: 18_000 },
            secondary_window: { used_percent: 0, reset_after_seconds: 604_800 },
          },
        },
      ],
      null,
      { unexpected: "ignored rather than validated" },
    ].map((additionalRateLimits) => ({ additionalRateLimits })),
  )("ignores additional model quotas from the API: %j", async ({ additionalRateLimits }) => {
    const result = await fetchCodexUsage({
      authClient: tokenAuthClient(makeJwt("acct_abc")),
      fetchJson: okFetch({
        additional_rate_limits: additionalRateLimits,
        rate_limit: {
          allowed: false,
          primary_window: { used_percent: 100 },
          secondary_window: { used_percent: 50 },
        },
        credits: { balance: 12.5, has_credits: true },
      }),
      now: () => 1000,
    });

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 1000,
        provider: "openai-codex",
        ordinaryUsageAllowed: false,
        accounting: { available: 12.5, kind: "credit-balance" },
        quotaWindows: [
          { id: "5h", label: "5h", remainingPercent: 0 },
          { id: "7d", label: "7d", remainingPercent: 50 },
        ],
      },
    });
  });

  it("does not treat model-specific quotas alone as supported usage", async () => {
    const result = await fetchCodexUsage({
      authClient: tokenAuthClient(makeJwt("acct_abc")),
      fetchJson: okFetch({
        rate_limit: null,
        additional_rate_limits: [
          {
            limit_name: "Spark",
            metered_feature: "codex_bengalfox",
            rate_limit: { allowed: true, primary_window: { used_percent: 0 } },
          },
        ],
      }),
      now: () => 1000,
    });

    expect(result).toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "no usage data in response" },
    });
  });
});
