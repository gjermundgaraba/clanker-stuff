import { Type } from "typebox";
import type { Static } from "typebox";

import { resolveOAuthAccess } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow, parseIso } from "./util.js";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

const CREDITS_URL = `${BILLING_URL}?format=credits`;

const MoneySchema = Type.Union([Type.Number(), Type.Object({ val: Type.Number() })]);

const XaiConfigSchema = Type.Object({
  billingPeriodEnd: Type.Optional(Type.String()),
  creditUsagePercent: Type.Optional(Type.Number()),
  currentPeriod: Type.Optional(
    Type.Object({
      end: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
    }),
  ),
  monthlyLimit: Type.Optional(MoneySchema),
  prepaidBalance: Type.Optional(MoneySchema),
  used: Type.Optional(MoneySchema),
});

const XaiPayloadSchema = Type.Object({
  config: XaiConfigSchema,
});

type XaiConfig = Static<typeof XaiConfigSchema>;

export type XaiPayload = Static<typeof XaiPayloadSchema>;

const moneyValue = (value: XaiConfig["monthlyLimit"]): number | undefined =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Discriminate the schema-derived numeric/object quota union before reading its amount.
  typeof value === "number" ? value : value?.val;

export const mapXaiMonthlyPayload = (payload: XaiPayload): UsageWindow | undefined => {
  const config = payload.config;
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

export const mapXaiWeeklyPayload = (payload: XaiPayload): UsageWindow | undefined => {
  const config = payload.config;

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

  const resetsAt = parseIso(currentPeriod?.end) ?? parseIso(config.billingPeriodEnd);

  return makeUsageWindow("week", 100 - usagePercent, resetsAt);
};

const mapXaiPrepaidBalance = (payload: XaiPayload): number | undefined =>
  moneyValue(payload.config.prepaidBalance);

export const mapXaiUsagePayloads = (
  monthlyPayload: XaiPayload | undefined,
  weeklyPayload: XaiPayload | undefined,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const windows = [
    monthlyPayload === undefined ? undefined : mapXaiMonthlyPayload(monthlyPayload),
    weeklyPayload === undefined ? undefined : mapXaiWeeklyPayload(weeklyPayload),
  ].filter(isDefined);

  const prepaidBalance =
    weeklyPayload === undefined ? undefined : mapXaiPrepaidBalance(weeklyPayload);

  return usageResult({
    ...(prepaidBalance === undefined
      ? {}
      : { accounting: { available: prepaidBalance, kind: "credit-balance" as const } }),
    fetchedAt: nowMs,
    provider: "xai",
    quotaWindows: windows,
  });
};

export const fetchXaiUsage = async (deps: AdapterDeps): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveOAuthAccess(deps.authClient, "xai");

  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.value.accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
  };

  const monthlyPromise = deps.fetchJson(BILLING_URL, XaiPayloadSchema, {
    headers,
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  const weeklyPromise = (async () => {
    try {
      return await deps.fetchJson(CREDITS_URL, XaiPayloadSchema, {
        headers,
        timeoutMs: USAGE_HTTP_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  })();

  const monthly = await monthlyPromise;

  if (!monthly.ok && monthly.kind === "response") {
    return usageFailure(monthly.message);
  }

  const weekly = await weeklyPromise;

  return mapXaiUsagePayloads(
    monthly.ok ? monthly.json : undefined,
    weekly !== null && weekly.ok ? weekly.json : undefined,
    now(),
  );
};
