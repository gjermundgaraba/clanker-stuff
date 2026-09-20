import { Type } from "typebox";
import type { Static } from "typebox";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult } from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { parseIso } from "./util.js";

const RadiusBillingPayloadSchema = Type.Object({
  balance: Type.Object({
    available: Type.Number(),
    credit_balance: Type.Number(),
    reserved: Type.Number(),
  }),
  currency: Type.Literal("USD"),
  current_period: Type.Object({
    actual_charged: Type.Number({ minimum: 0 }),
    ends_at: Type.String(),
  }),
  ok: Type.Literal(true),
});

export type RadiusBillingPayload = Static<typeof RadiusBillingPayloadSchema>;

export const mapRadiusBillingPayload = (
  payload: RadiusBillingPayload,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const periodEndsAt = parseIso(payload.current_period.ends_at);

  if (periodEndsAt === undefined) {
    return usageFailure("invalid billing period end");
  }

  return usageResult({
    accounting: {
      available: payload.balance.available,
      balance: payload.balance.credit_balance,
      currentMonthSpend: payload.current_period.actual_charged,
      kind: "radius-billing",
      periodEndsAt,
      reserved: payload.balance.reserved,
    },
    fetchedAt: nowMs,
    provider: "radius",
    quotaWindows: [],
  });
};

export const fetchRadiusUsage = async (
  deps: AdapterDeps,
  billingUrl: string,
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "radius");

  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(billingUrl, RadiusBillingPayloadSchema, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.value.accessToken}`,
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  return response.ok
    ? mapRadiusBillingPayload(response.json, now())
    : usageFailure(response.message);
};
