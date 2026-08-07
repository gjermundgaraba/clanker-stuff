import { describe, expect, it, vi } from "vitest";

import {
  fetchCodexUsage,
  parseCodexUsagePayload,
} from "../../adapters/codex.js";
import type { ProviderAuthClient } from "../../auth.js";
import type { FetchJson } from "../../http.js";

const makeJwt = (accountId: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url"
  );
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })
  ).toString("base64url");
  return `${header}.${body}.sig`;
};

describe("codex payload parsing", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");

  it("maps primary/secondary windows, plan, and credits", () => {
    const result = parseCodexUsagePayload(
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
      now
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        creditsRemaining: 12.5,
        fetchedAt: now,
        planLabel: "plus",
        provider: "openai-codex",
        windows: [
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
    const result = parseCodexUsagePayload(
      {
        credits: { balance: "12.5", has_credits: true },
        rate_limit: {
          primary_window: { used_percent: 32 },
          secondary_window: null,
        },
      },
      now
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        creditsRemaining: 12.5,
        fetchedAt: now,
        provider: "openai-codex",
        windows: [{ id: "5h", label: "5h", remainingPercent: 68 }],
      },
    });
  });

  it("accepts a null credit balance", () => {
    const result = parseCodexUsagePayload(
      {
        credits: { balance: null, has_credits: false },
        rate_limit: {
          primary_window: { used_percent: 32 },
          secondary_window: null,
        },
      },
      now
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: now,
        provider: "openai-codex",
        windows: [{ id: "5h", label: "5h", remainingPercent: 68 }],
      },
    });
  });

  it("fails when windows are missing", () => {
    const result = parseCodexUsagePayload({ rate_limit: {} }, now);
    expect(result.ok).toBeFalsy();
  });

  it("labels team primary window as 7d from limit_window_seconds", () => {
    const result = parseCodexUsagePayload(
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
      now
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: now,
        planLabel: "team",
        provider: "openai-codex",
        windows: [
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
    const result = parseCodexUsagePayload(
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
      now
    );
    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.windows.map((window) => window.id)).toStrictEqual([
      "5h",
      "7d",
    ]);
    expect(
      result.snapshot.windows.map((window) => window.remainingPercent)
    ).toStrictEqual([60, 75]);
  });
});

describe("codex fetch", () => {
  it("rejects OAuth tokens without a ChatGPT account id", async () => {
    const fetchJson = vi.fn<FetchJson>();
    const result = await fetchCodexUsage({
      authClient: {
        getProviderAuth: async () => ({
          auth: { apiKey: "not-a-jwt" },
          source: "OAuth",
        }),
      },
      fetchJson,
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
    const fetchJson = vi.fn<FetchJson>(async () => ({
      json: {
        rate_limit: {
          primary_window: { used_percent: 10 },
        },
      },
      ok: true,
    }));

    const result = await fetchCodexUsage({
      authClient,
      fetchJson,
      now: () => 1000,
    });

    expect(result.ok).toBeTruthy();
    const [url, options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
    expect(options?.headers?.["ChatGPT-Account-Id"]).toBe("acct_abc");
  });
});
