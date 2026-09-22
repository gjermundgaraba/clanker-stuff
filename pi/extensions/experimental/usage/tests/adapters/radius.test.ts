import { describe, expect, it, vi } from "vite-plus/test";

import { fetchRadiusUsage, mapRadiusBillingPayload } from "../../adapters/radius.js";
import type { FetchJson } from "../../http.js";
import { NOW, okFetch, tokenAuthClient } from "./helpers.js";

const BILLING_URL = "https://radius.pi.dev/v1/billing";

const payload = {
  balance: {
    available: 43.261059929,
    credit_balance: 46.51540073,
    reserved: 3.254340801,
  },
  currency: "USD" as const,
  current_period: {
    actual_charged: 33.48459927,
    ends_at: "2026-10-01T00:00:00.000Z",
  },
  ok: true as const,
};

const fetchPayload = async (value: unknown) =>
  await fetchRadiusUsage(
    {
      authClient: tokenAuthClient("token"),
      fetchJson: okFetch(value),
      now: () => NOW,
    },
    BILLING_URL,
  );

describe("radius usage", () => {
  it("maps live USD accounting", () => {
    expect(mapRadiusBillingPayload(payload, NOW)).toStrictEqual({
      ok: true,
      snapshot: {
        accounting: {
          available: 43.261059929,
          balance: 46.51540073,
          currentMonthSpend: 33.48459927,
          kind: "radius-billing",
          periodEndsAt: "2026-10-01T00:00:00.000Z",
          reserved: 3.254340801,
        },
        fetchedAt: NOW,
        provider: "radius",
        quotaWindows: [],
      },
    });
  });

  it("accepts and preserves a negative available balance", async () => {
    const result = await fetchPayload({
      ...payload,
      balance: { ...payload.balance, available: -1.25 },
    });

    expect(result.ok && result.snapshot.accounting?.available).toBe(-1.25);
  });

  it.each([
    ["non-USD currency", { ...payload, currency: "EUR" }],
    [
      "negative finalized charges",
      { ...payload, current_period: { ...payload.current_period, actual_charged: -1 } },
    ],
  ])("rejects %s", async (_name, value) => {
    await expect(fetchPayload(value)).resolves.toStrictEqual({
      error: { kind: "failure", message: "invalid usage payload" },
      ok: false,
    });
  });

  it("rejects an invalid billing period end", async () => {
    await expect(
      fetchPayload({
        ...payload,
        current_period: { ...payload.current_period, ends_at: "not a date" },
      }),
    ).resolves.toStrictEqual({
      error: { kind: "failure", message: "invalid billing period end" },
      ok: false,
    });
  });

  it("requests the resolved billing URL", async () => {
    const client = { fetchJson: okFetch(payload) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchRadiusUsage(
      {
        authClient: tokenAuthClient("token"),
        fetchJson: client.fetchJson,
        now: () => NOW,
      },
      BILLING_URL,
    );

    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith(
      BILLING_URL,
      expect.any(Object),
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer token" },
      }),
    );
  });
});
