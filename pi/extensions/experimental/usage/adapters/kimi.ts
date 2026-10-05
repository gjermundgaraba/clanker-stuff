import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import {
  fetchUsage,
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
    }),
  ),
});

const KimiUsagePayloadSchema = Type.Object({
  limits: Type.Optional(Type.Array(KimiLimitSchema)),
  usage: Type.Optional(KimiUsageSummarySchema),
});

const remainingFromLimit = (limit: number, remaining: number): number | undefined => {
  if (limit <= 0) {
    return undefined;
  }

  return (remaining / limit) * 100;
};

const UNIT_SECONDS = new Map([
  ["TIME_UNIT_MINUTE", 60],
  ["TIME_UNIT_HOUR", 3600],
  ["TIME_UNIT_DAY", 86_400],
]);

const windowSeconds = (
  windowInfo: Static<typeof KimiLimitSchema>["window"],
): number | undefined => {
  const unit = UNIT_SECONDS.get(windowInfo?.timeUnit ?? "");

  return unit === undefined || windowInfo?.duration === undefined
    ? undefined
    : windowInfo.duration * unit;
};

/** Labels a window with its actual length, in the largest whole unit. */
const durationLabel = (seconds: number): string => {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }

  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }

  return `${Math.round(seconds / 60)}m`;
};

const parseLimitEntry = (limitEntry: Static<typeof KimiLimitSchema>): UsageWindow | undefined => {
  const { detail, window: windowInfo } = limitEntry;
  const limit = detail?.limit ?? 0;
  const remaining = detail?.remaining ?? 0;
  const remainingPercent = remainingFromLimit(limit, remaining);

  if (remainingPercent === undefined) {
    return undefined;
  }

  const seconds = windowSeconds(windowInfo);
  const id = seconds === undefined ? undefined : windowIdFromLimitSeconds(seconds);
  const resetsAt = parseIso(detail?.resetTime);

  // Without a usable length, the rolling limit is Kimi's five-hour window.
  if (seconds === undefined || id === undefined) {
    return makeUsageWindow("5h", remainingPercent, resetsAt);
  }

  return makeUsageWindow(id, remainingPercent, resetsAt, durationLabel(seconds));
};

export const mapKimiUsagePayload = (
  payload: Static<typeof KimiUsagePayloadSchema>,
  nowMs: number = Date.now(),
): UsageFetchResult => {
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

  return usageResult({ fetchedAt: nowMs, provider: "kimi-coding", quotaWindows: windows });
};

export const fetchKimiUsage = (deps: AdapterDeps): Promise<UsageFetchResult> =>
  fetchUsage(
    deps,
    "kimi-coding",
    {
      url: KIMI_USAGE_URL,
      schema: KimiUsagePayloadSchema,
      headers: { "Content-Type": "application/json" },
    },
    mapKimiUsagePayload,
  );
