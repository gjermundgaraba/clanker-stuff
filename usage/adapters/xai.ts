import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveOAuthAccess } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow } from "../types.js";
import { usageFailure, usageResult } from "../types.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow, parseIso } from "./util.js";

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

const configFromPayload = (
  payload: unknown
): Static<typeof XaiConfigSchema> | undefined =>
  Value.Check(XaiPayloadSchema, payload) ? payload.config : undefined;

const moneyValue = (
  value: Static<typeof MoneySchema> | undefined
): number | undefined => (typeof value === "number" ? value : value?.val);

export const parseXaiMonthlyPayload = (
  payload: unknown
): UsageWindow | undefined => {
  const config = configFromPayload(payload);
  if (config === undefined) {
    return undefined;
  }
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

export const parseXaiWeeklyPayload = (
  payload: unknown
): UsageWindow | undefined => {
  const config = configFromPayload(payload);
  if (config === undefined) {
    return undefined;
  }

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

const parseXaiPrepaidBalance = (payload: unknown): number | undefined => {
  const config = configFromPayload(payload);
  if (config === undefined) {
    return undefined;
  }
  return moneyValue(config.prepaidBalance);
};

export const parseXaiUsagePayloads = (
  monthlyPayload: unknown,
  weeklyPayload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  const windows = [
    parseXaiMonthlyPayload(monthlyPayload),
    parseXaiWeeklyPayload(weeklyPayload),
  ].filter(isDefined);

  const creditsRemaining = parseXaiPrepaidBalance(weeklyPayload);

  return usageResult({
    fetchedAt: nowMs,
    provider: "xai",
    windows,
    ...(creditsRemaining === undefined ? {} : { creditsRemaining }),
  });
};

export const fetchXaiUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
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

  const monthly = await deps.fetchJson(BILLING_URL, {
    headers,
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (!monthly.ok) {
    return usageFailure(monthly.message);
  }

  const weekly = await deps.fetchJson(CREDITS_URL, {
    headers,
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  return parseXaiUsagePayloads(
    monthly.json,
    weekly.ok ? weekly.json : undefined,
    now()
  );
};
