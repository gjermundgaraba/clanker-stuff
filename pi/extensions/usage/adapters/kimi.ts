import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import {
  isDefined,
  makeUsageWindow,
  parseIso,
  windowIdFromLimitSeconds,
} from "./util.js";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

const KimiUsageSummarySchema = Type.Object({
  limit: Type.Optional(Type.Number()),
  remaining: Type.Optional(Type.Number()),
  resetTime: Type.Optional(Type.String()),
});

const KimiLimitSchema = Type.Object({
  detail: Type.Optional(KimiUsageSummarySchema),
  window: Type.Optional(
    Type.Object({
      duration: Type.Optional(Type.Number()),
      timeUnit: Type.Optional(Type.String()),
    })
  ),
});

const KimiUsagePayloadSchema = Type.Object({
  limits: Type.Optional(Type.Array(KimiLimitSchema)),
  usage: Type.Optional(KimiUsageSummarySchema),
});

const remainingFromLimit = (
  limit: number,
  remaining: number
): number | undefined => {
  if (limit <= 0) {
    return undefined;
  }
  return (remaining / limit) * 100;
};

const parseLimitEntry = (
  limitEntry: Static<typeof KimiLimitSchema>
): UsageWindow | undefined => {
  const { detail, window: windowInfo } = limitEntry;
  const limit = detail?.limit ?? 0;
  const remaining = detail?.remaining ?? 0;
  const remainingPercent = remainingFromLimit(limit, remaining);
  if (remainingPercent === undefined) {
    return undefined;
  }

  const durationMinutes =
    windowInfo?.timeUnit === "TIME_UNIT_MINUTE"
      ? windowInfo.duration
      : undefined;
  const id =
    durationMinutes === undefined
      ? "5h"
      : (windowIdFromLimitSeconds(durationMinutes * 60) ?? "5h");
  return makeUsageWindow(id, remainingPercent, parseIso(detail?.resetTime));
};

export const parseKimiUsagePayload = (
  payload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(KimiUsagePayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  const { limits = [], usage } = payload;
  const weeklyLimit = usage?.limit ?? 0;
  const weeklyRemaining = usage?.remaining ?? 0;
  const weeklyPercent = remainingFromLimit(weeklyLimit, weeklyRemaining);
  const windows = [
    ...limits.map(parseLimitEntry),
    weeklyPercent === undefined
      ? undefined
      : makeUsageWindow("week", weeklyPercent, parseIso(usage?.resetTime)),
  ].filter(isDefined);

  return usageResult({
    fetchedAt: nowMs,
    provider: "kimi-coding",
    windows,
  });
};

export const fetchKimiUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "kimi-coding");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(KIMI_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.value.accessToken}`,
      "Content-Type": "application/json",
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseKimiUsagePayload(response.json, now());
  }

  return usageFailure(response.message);
};
