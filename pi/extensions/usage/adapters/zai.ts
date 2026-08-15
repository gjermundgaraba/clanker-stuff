import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type {
  UsageFetchResult,
  UsageWindow,
  UsageWindowId,
} from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow } from "./util.js";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const ZaiLimitSchema = Type.Object({
  nextResetTime: Type.Optional(Type.Number()),
  percentage: Type.Optional(Type.Number()),
  remaining: Type.Optional(Type.Number()),
  type: Type.Optional(Type.String()),
  unit: Type.Optional(Type.Number()),
  usage: Type.Optional(Type.Number()),
});

const ZaiQuotaPayloadSchema = Type.Object({
  code: Type.Optional(Type.Number()),
  data: Type.Optional(
    Type.Object({
      level: Type.Optional(Type.String()),
      limits: Type.Optional(Type.Array(ZaiLimitSchema)),
    })
  ),
  msg: Type.Optional(Type.String()),
});

type ZaiLimit = Static<typeof ZaiLimitSchema>;

/**
 * Quota windows are TOKENS_LIMIT/CREDIT_LIMIT (seen across plan
 * generations); TIME_LIMIT is the monthly web-search count. Unknown types
 * are dropped rather than guessed by unit — a rejected new type surfaces as
 * a visible "no usage windows" error instead of a wrong quota (cf. CodexBar
 * issue #2724). Unit is an opaque enum: 3 marks the sub-daily window, 6 the
 * multi-day one; `number` is ignored because its meaning flipped between
 * plan generations (7 vs 1 for weekly).
 */
const windowIdFromLimit = (limit: ZaiLimit): UsageWindowId | undefined => {
  if (limit.type === "TIME_LIMIT") {
    return "month";
  }
  if (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT") {
    return undefined;
  }
  if (limit.unit === 3) {
    return "5h";
  }
  if (limit.unit === 6) {
    return "7d";
  }
  return undefined;
};

const remainingPercentFrom = (limit: ZaiLimit): number | undefined => {
  const total = limit.usage;
  if (total !== undefined && total > 0 && limit.remaining !== undefined) {
    return (limit.remaining / total) * 100;
  }
  // percentage is used percent on this endpoint.
  return limit.percentage === undefined ? undefined : 100 - limit.percentage;
};

const epochMsToIso = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : new Date(value).toISOString();

const parseLimitEntry = (limit: ZaiLimit): UsageWindow | undefined => {
  const remainingPercent = remainingPercentFrom(limit);
  const id = windowIdFromLimit(limit);
  if (remainingPercent === undefined || id === undefined) {
    return undefined;
  }
  return makeUsageWindow(
    id,
    remainingPercent,
    epochMsToIso(limit.nextResetTime)
  );
};

const planLabelFromLevel = (level: string | undefined): string | undefined =>
  level === undefined || level.length === 0
    ? undefined
    : `${level[0].toUpperCase()}${level.slice(1)}`;

export const parseZaiQuotaPayload = (
  payload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(ZaiQuotaPayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  const { code } = payload;
  if (code !== undefined && code !== 200) {
    const message =
      payload.msg !== undefined && payload.msg.length > 0
        ? payload.msg
        : `API ${code}`;
    return usageFailure(message);
  }

  const windows = (payload.data?.limits ?? [])
    .map(parseLimitEntry)
    .filter(isDefined);

  const planLabel = planLabelFromLevel(payload.data?.level);

  return usageResult({
    fetchedAt: nowMs,
    ...(planLabel === undefined ? {} : { planLabel }),
    provider: "zai",
    windows,
  });
};

export const fetchZaiUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "zai");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(ZAI_QUOTA_URL, {
    headers: {
      Authorization: `Bearer ${auth.value.accessToken}`,
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseZaiQuotaPayload(response.json, now());
  }

  return usageFailure(response.message);
};
