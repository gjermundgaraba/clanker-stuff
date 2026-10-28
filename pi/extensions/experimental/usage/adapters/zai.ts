import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { fetchUsage, isoFromEpochMs, makeUsageWindow } from "./util.js";

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

const windowLabel = (limit: ZaiLimit): string | undefined => {
  if (limit.type === "TIME_LIMIT") {
    return "web search month";
  }

  if (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT") {
    return undefined;
  }

  if (limit.unit === 3) {
    return "5h";
  }

  if (limit.unit === 6) {
    return "week";
  }

  return undefined;
};

const remainingPercentFrom = (limit: ZaiLimit): number | undefined => {
  const total = limit.usage;

  if (total !== undefined && total > 0 && limit.remaining !== undefined) {
    return (limit.remaining / total) * 100;
  }

  return limit.percentage === undefined ? undefined : 100 - limit.percentage;
};

const parseLimitEntry = (limit: ZaiLimit): UsageWindow | undefined => {
  const remainingPercent = remainingPercentFrom(limit);
  const label = windowLabel(limit);

  if (remainingPercent === undefined || label === undefined) {
    return undefined;
  }

  return makeUsageWindow(
    label,
    remainingPercent,
    isoFromEpochMs(limit.nextResetTime)
  );
};

const planLabelFromLevel = (level: string | undefined): string | undefined =>
  level === undefined || level.length === 0
    ? undefined
    : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

export const mapZaiQuotaPayload = (
  payload: Static<typeof ZaiQuotaPayloadSchema>,
  nowMs: number
): UsageFetchResult => {
  const { code } = payload;

  if (code !== undefined && code !== 200) {
    const message =
      payload.msg !== undefined && payload.msg.length > 0
        ? payload.msg
        : `API ${code}`;

    return usageFailure(message);
  }

  const quotaWindows: UsageWindow[] = [];
  const additionalQuotaWindows: UsageWindow[] = [];

  for (const limit of payload.data?.limits ?? []) {
    const window = parseLimitEntry(limit);

    if (window === undefined) {
      continue;
    }

    (limit.type === "TIME_LIMIT" ? additionalQuotaWindows : quotaWindows).push(
      window
    );
  }

  const planLabel = planLabelFromLevel(payload.data?.level);

  return usageResult({
    fetchedAt: nowMs,
    ...(planLabel === undefined ? {} : { planLabel }),
    provider: "zai",
    quotaWindows,
    ...(additionalQuotaWindows.length === 0 ? {} : { additionalQuotaWindows }),
  });
};

export const fetchZaiUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> =>
  await fetchUsage(
    deps,
    "zai",
    { url: ZAI_QUOTA_URL, schema: ZaiQuotaPayloadSchema },
    mapZaiQuotaPayload
  );
