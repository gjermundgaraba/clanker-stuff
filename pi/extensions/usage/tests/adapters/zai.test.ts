import { describe, expect, it, vi } from "vite-plus/test";

import { fetchZaiUsage, parseZaiQuotaPayload, ZaiQuotaPayloadSchema } from "../../adapters/zai.js";
import { Value } from "typebox/value";
import type { FetchJson } from "../../http.js";
import { NOW, okFetch, tokenAuthClient } from "./helpers.js";

// Live shape observed on a GLM Coding Pro (credit-based) account.
const creditPayload = {
  code: 200,
  data: {
    level: "pro",
    limits: [
      {
        currentValue: 3553,
        nextResetTime: NOW + 2 * 3_600_000,
        number: 5,
        percentage: 29,
        remaining: 8446,
        type: "CREDIT_LIMIT",
        unit: 3,
        usage: 12_000,
      },
      {
        currentValue: 10_658,
        nextResetTime: NOW + 6 * 86_400_000,
        number: 1,
        percentage: 17,
        remaining: 49_341,
        type: "CREDIT_LIMIT",
        unit: 6,
        usage: 60_000,
      },
    ],
  },
  msg: "Operation successful",
  success: true,
};

// Token-based plans report TOKENS_LIMIT and a monthly web-search TIME_LIMIT.
const tokenPayload = {
  code: 200,
  data: {
    level: "lite",
    limits: [
      {
        currentValue: 127_694_464,
        nextResetTime: NOW + 3_600_000,
        number: 5,
        percentage: 15,
        remaining: 672_305_536,
        type: "TOKENS_LIMIT",
        unit: 3,
        usage: 800_000_000,
      },
      {
        currentValue: 1_000_000_000,
        nextResetTime: NOW + 5 * 86_400_000,
        number: 7,
        percentage: 17,
        remaining: 5_000_000_000,
        type: "TOKENS_LIMIT",
        unit: 6,
        usage: 6_000_000_000,
      },
      {
        currentValue: 1828,
        number: 1,
        percentage: 45,
        remaining: 2172,
        type: "TIME_LIMIT",
        unit: 5,
        usage: 4000,
      },
    ],
  },
  success: true,
};

describe("zai usage", () => {
  it("maps credit windows and plan level", () => {
    const result = parseZaiQuotaPayload(creditPayload, NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        planLabel: "Pro",
        provider: "zai",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: (8446 / 12_000) * 100,
            resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
          },
          {
            id: "7d",
            label: "7d",
            remainingPercent: (49_341 / 60_000) * 100,
            resetsAt: new Date(NOW + 6 * 86_400_000).toISOString(),
          },
        ],
      },
    });
  });

  it("maps token windows and monthly web-search limit", () => {
    const result = parseZaiQuotaPayload(tokenPayload, NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        planLabel: "Lite",
        provider: "zai",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: (672_305_536 / 800_000_000) * 100,
            resetsAt: new Date(NOW + 3_600_000).toISOString(),
          },
          {
            id: "7d",
            label: "7d",
            remainingPercent: (5_000_000_000 / 6_000_000_000) * 100,
            resetsAt: new Date(NOW + 5 * 86_400_000).toISOString(),
          },
          {
            id: "month",
            label: "month",
            remainingPercent: (2172 / 4000) * 100,
          },
        ],
      },
    });
  });

  it("falls back to percentage when counts are missing", () => {
    const result = parseZaiQuotaPayload(
      {
        code: 200,
        data: {
          level: "pro",
          limits: [{ percentage: 30, type: "CREDIT_LIMIT", unit: 3 }],
        },
      },
      NOW,
    );
    expect(result.ok && result.snapshot.windows[0]?.remainingPercent).toBe(70);
  });

  it("surfaces the error envelope returned with HTTP 200", () => {
    const result = parseZaiQuotaPayload({ code: 401, msg: "token expired or incorrect" }, NOW);
    expect(result).toStrictEqual({
      error: { kind: "failure", message: "token expired or incorrect" },
      ok: false,
    });
  });

  it("ignores unknown limit types", () => {
    const result = parseZaiQuotaPayload(
      {
        code: 200,
        data: {
          level: "pro",
          limits: [
            { percentage: 95, type: "RATE_LIMIT", unit: 3 },
            { percentage: 30, type: "CREDIT_LIMIT", unit: 3 },
          ],
        },
      },
      NOW,
    );
    expect(result.ok && result.snapshot.windows).toStrictEqual([
      {
        id: "5h",
        label: "5h",
        remainingPercent: 70,
      },
    ]);
  });

  it("rejects invalid payloads", () => {
    const invalidCode = { code: "200" };
    expect(Value.Check(ZaiQuotaPayloadSchema, invalidCode)).toBe(false);
    const result = parseZaiQuotaPayload(undefined, NOW);
    expect(result).toStrictEqual({
      error: { kind: "failure", message: "invalid usage payload" },
      ok: false,
    });
  });

  it("fails when no usable limits are present", () => {
    const result = parseZaiQuotaPayload({ code: 200, data: { limits: [] } }, NOW);
    expect(result).toStrictEqual({
      error: { kind: "failure", message: "no usage windows in response" },
      ok: false,
    });
  });

  it("fetches the quota endpoint with bearer auth", async () => {
    const fetchJson = vi.fn<FetchJson>(okFetch(creditPayload));
    const result = await fetchZaiUsage({
      authClient: tokenAuthClient("k"),
      fetchJson,
      now: () => NOW,
    });
    expect(fetchJson.mock.calls[0]?.[0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(fetchJson.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer k",
    });
    expect(result.ok && result.snapshot.planLabel).toBe("Pro");
  });
});
