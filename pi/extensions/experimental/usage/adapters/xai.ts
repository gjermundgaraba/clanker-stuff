import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import {
  isDefined,
  makeUsageWindow,
  parseIso,
  responseFailure,
  usageHeaders,
} from "./util.js";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

const CREDITS_URL = `${BILLING_URL}?format=credits`;

const MoneySchema = Type.Union([
  Type.Number(),
  Type.Object({ val: Type.Number() }),
]);

const XaiConfigSchema = Type.Object({
  billingPeriodEnd: Type.Optional(Type.String()),
  creditUsagePercent: Type.Optional(Type.Number()),
  currentPeriod: Type.Optional(
    Type.Object({
      end: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
    })
  ),
  monthlyLimit: Type.Optional(MoneySchema),
  prepaidBalance: Type.Optional(MoneySchema),
  used: Type.Optional(MoneySchema),
});

const XaiPayloadSchema = Type.Object({
  config: XaiConfigSchema,
});

type XaiConfig = Static<typeof XaiConfigSchema>;

type XaiPayload = Static<typeof XaiPayloadSchema>;

const moneyValue = (value: XaiConfig["monthlyLimit"]): number | undefined =>
  typeof value === "number" ? value : value?.val;

export const mapXaiMonthlyPayload = (
  payload: XaiPayload
): UsageWindow | undefined => {
  const { config } = payload;
  const monthlyLimit = moneyValue(config.monthlyLimit);
  const used = moneyValue(config.used);

  if (monthlyLimit === undefined || used === undefined) {
    return undefined;
  }

  let remainingPercent: number;

  if (monthlyLimit > 0) {
    remainingPercent = 100 * (1 - used / monthlyLimit);
  } else if (used > 0) {
    remainingPercent = 0;
  } else {
    remainingPercent = 100;
  }

  const resetsAt = parseIso(config.billingPeriodEnd);

  return makeUsageWindow("month", remainingPercent, resetsAt);
};

export const mapXaiWeeklyPayload = (
  payload: XaiPayload
): UsageWindow | undefined => {
  const { config } = payload;

  const { currentPeriod } = config;

  if (
    currentPeriod !== undefined &&
    currentPeriod.type !== undefined &&
    !currentPeriod.type.includes("WEEKLY")
  ) {
    return undefined;
  }

  const usagePercent = config.creditUsagePercent;

  if (usagePercent === undefined) {
    return undefined;
  }

  const resetsAt =
    parseIso(currentPeriod?.end) ?? parseIso(config.billingPeriodEnd);

  return makeUsageWindow("week", 100 - usagePercent, resetsAt);
};

export const mapXaiUsagePayloads = (
  monthlyPayload: XaiPayload | undefined,
  weeklyPayload: XaiPayload | undefined,
  nowMs: number
): UsageFetchResult => {
  const windows = [
    weeklyPayload === undefined
      ? undefined
      : mapXaiWeeklyPayload(weeklyPayload),
    monthlyPayload === undefined
      ? undefined
      : mapXaiMonthlyPayload(monthlyPayload),
  ].filter(isDefined);

  const prepaidBalance = moneyValue(weeklyPayload?.config.prepaidBalance);

  return usageResult({
    ...(prepaidBalance === undefined
      ? {}
      : {
          accounting: {
            available: prepaidBalance,
            kind: "credit-balance" as const,
          },
        }),
    fetchedAt: nowMs,
    provider: "xai",
    quotaWindows: windows,
  });
};

export const fetchXaiUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const auth = await usageHeaders(deps, "xai", {
    oauth: true,
    headers: () => ({ "x-xai-token-auth": "xai-grok-cli" }),
  });

  if (!auth.ok) {
    return auth;
  }

  const [monthly, weekly] = await Promise.all([
    deps.fetchJson(BILLING_URL, XaiPayloadSchema, auth.headers),
    deps.fetchJson(CREDITS_URL, XaiPayloadSchema, auth.headers),
  ]);

  if (!monthly.ok && !weekly.ok) {
    return responseFailure(monthly);
  }

  return mapXaiUsagePayloads(
    monthly.ok ? monthly.json : undefined,
    weekly.ok ? weekly.json : undefined,
    deps.now()
  );
};
