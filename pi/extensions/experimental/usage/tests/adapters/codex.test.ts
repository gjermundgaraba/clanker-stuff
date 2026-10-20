import { describe, expect, it, vi } from "vite-plus/test";

import { fetchCodexUsage } from "../../adapters/codex.js";
import type { GetAuth } from "../../auth.js";
import { CODEX_TOKEN, NOW, okFetch, tokenAuth } from "./helpers.js";

const resetAt = NOW / 1000 + 7200;

const resetIso = new Date(resetAt * 1000).toISOString();

const window = (seconds: number, used = 25) => ({
  used_percent: used,
  limit_window_seconds: seconds,
  reset_at: resetAt,
});

const fetchPayload = (payload: unknown) =>
  fetchCodexUsage({
    getAuth: tokenAuth(CODEX_TOKEN),
    fetchJson: okFetch(payload),
    now: () => NOW,
  });

describe("Codex usage", () => {
  it("keeps main and supplementary windows separate, with exact durations and resets", async () => {
    const result = await fetchPayload({
      plan_type: "pro",
      rate_limit: {
        primary_window: window(10_800),
        secondary_window: window(604_800, 60),
      },
      additional_rate_limits: [
        {
          limit_name: "Spark",
          // Unused metered_feature metadata is not needed to display this bucket.
          rate_limit: {
            primary_window: window(18_000, 100),
            secondary_window: window(604_800, 80),
          },
        },
      ],
      credits: { has_credits: true, unlimited: false, balance: "123" },
    });

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "openai-codex",
        planLabel: "pro",
        quotaWindows: [
          { label: "3h", remainingPercent: 75, resetsAt: resetIso },
          { label: "7d", remainingPercent: 40, resetsAt: resetIso },
        ],
        additionalQuotaWindows: [
          { label: "Spark 5h", remainingPercent: 0, resetsAt: resetIso },
          { label: "Spark 7d", remainingPercent: 20, resetsAt: resetIso },
        ],
        accounting: { kind: "credit-balance", available: 123 },
      },
    });
  });

  it.each([
    { seconds: 604_800, label: "7d" },
    { seconds: 2_592_000, label: "30d" },
    { seconds: 90, label: "90s" },
  ])("uses the returned primary duration ($label)", async ({ seconds, label }) => {
    await expect(
      fetchPayload({ rate_limit: { primary_window: window(seconds), secondary_window: null } }),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: { quotaWindows: [{ label, remainingPercent: 75, resetsAt: resetIso }] },
    });
  });

  it.each([undefined, 8_640_000_000_001])(
    "preserves quota with an unrepresentable reset (%j) and clamps outlying percentages",
    async (reset_at) => {
      await expect(
        fetchPayload({
          rate_limit: {
            primary_window: { ...window(18_000, 105), reset_at },
            secondary_window: { used_percent: -5, limit_window_seconds: 604_800 },
          },
        }),
      ).resolves.toStrictEqual({
        ok: true,
        snapshot: {
          fetchedAt: NOW,
          provider: "openai-codex",
          quotaWindows: [
            { label: "5h", remainingPercent: 0 },
            { label: "7d", remainingPercent: 100 },
          ],
        },
      });
    },
  );

  it("reports a metered credit balance without quota windows", async () => {
    await expect(
      fetchPayload({ rate_limit: null, credits: { has_credits: true, balance: " 12.50 " } }),
    ).resolves.toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "openai-codex",
        quotaWindows: [],
        accounting: { kind: "credit-balance", available: 12.5 },
      },
    });
  });

  it.each([
    { has_credits: false, unlimited: false, balance: "0" },
    { unlimited: false, balance: "5" },
    { has_credits: true, unlimited: true, balance: "0" },
    { has_credits: true, balance: null },
    { has_credits: true, balance: "" },
    { has_credits: true, balance: "12 credits" },
    { has_credits: true, balance: "1e9999" },
  ])("keeps quota but no balance for unmetered or unreadable credits: %j", async (credits) => {
    await expect(
      fetchPayload({ rate_limit: { primary_window: window(18_000) }, credits }),
    ).resolves.toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "openai-codex",
        quotaWindows: [{ label: "5h", remainingPercent: 75, resetsAt: resetIso }],
      },
    });
  });

  it.each([
    {},
    { plan_type: "free", rate_limit: { primary_window: null }, credits: { has_credits: false } },
  ])("fails a response without metrics instead of replacing cached usage: %j", async (payload) => {
    await expect(fetchPayload(payload)).resolves.toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "no usage data in response" },
    });
  });

  it.each([
    { rate_limit: { primary_window: { ...window(18_000), used_percent: "25" } } },
    { rate_limit: { primary_window: window(0) } },
    { rate_limit: { primary_window: { limit_window_seconds: 18_000 } } },
    { rate_limit: { primary_window: { ...window(18_000), reset_at: "soon" } } },
  ])("rejects invalid measurements: %j", async (payload) => {
    await expect(fetchPayload(payload)).resolves.toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "invalid usage payload" },
    });
  });

  it.each([
    { token: CODEX_TOKEN, account: { "ChatGPT-Account-Id": "codex-account" } },
    { token: "e30.e30.signature", account: {} },
    { token: "not-a-jwt", account: {} },
  ])(
    "routes with the resolved Codex OAuth token's account claim ($token)",
    async ({ token, account }) => {
      const getAuth = vi.fn<GetAuth>(tokenAuth(token));
      const client = { fetchJson: okFetch({ rate_limit: { primary_window: window(18_000) } }) };
      const fetchJson = vi.spyOn(client, "fetchJson");

      await fetchCodexUsage({ getAuth, fetchJson: client.fetchJson, now: () => NOW });

      expect(getAuth.mock.calls).toStrictEqual([["openai-codex"]]);
      expect(fetchJson).toHaveBeenCalledExactlyOnceWith(
        "https://chatgpt.com/backend-api/wham/usage",
        expect.any(Object),
        {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...account,
          "User-Agent": "pi-usage",
        },
      );
    },
  );

  it("does not send an API key to the subscription endpoint", async () => {
    const client = { fetchJson: okFetch({}) };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchCodexUsage({
      getAuth: async () => ({ auth: { apiKey: CODEX_TOKEN }, source: "Environment" }),
      fetchJson: client.fetchJson,
      now: () => NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
