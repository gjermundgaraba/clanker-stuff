import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

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

const MoneyNumberSchema = Type.Number();
const MoneyObjectSchema = Type.Object({ val: Type.Number() });

const moneyValue = (value: XaiConfig["monthlyLimit"]): number | undefined => {
  if (Value.Check(MoneyNumberSchema, value)) {
    return value;
  }
  return Value.Check(MoneyObjectSchema, value)
    ? Value.Parse(MoneyObjectSchema, value).val
    : undefined;
};

export const parseXaiMonthlyPayload = (payload: XaiPayload): UsageWindow | undefined => {
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

export const parseXaiWeeklyPayload = (payload: XaiPayload): UsageWindow | undefined => {
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

const parseXaiPrepaidBalance = (payload: XaiPayload): number | undefined =>
  moneyValue(payload.config.prepaidBalance);

export const parseXaiUsagePayloads = (
  monthlyPayload: XaiPayload | undefined,
  weeklyPayload: XaiPayload | undefined,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const windows = [
    monthlyPayload === undefined ? undefined : parseXaiMonthlyPayload(monthlyPayload),
    weeklyPayload === undefined ? undefined : parseXaiWeeklyPayload(weeklyPayload),
  ].filter(isDefined);

  const creditsRemaining =
    weeklyPayload === undefined ? undefined : parseXaiPrepaidBalance(weeklyPayload);

  return usageResult(
    creditsRemaining === undefined
      ? { fetchedAt: nowMs, provider: "xai", windows }
      : { creditsRemaining, fetchedAt: nowMs, provider: "xai", windows },
  );
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

  const monthlyPromise = deps.fetchJson(BILLING_URL, {
    headers,
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });
  const weeklyPromise = (async () => {
    try {
      return await deps.fetchJson(CREDITS_URL, {
        headers,
        timeoutMs: USAGE_HTTP_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  })();
  const monthly = await monthlyPromise;

  if (!monthly.ok) {
    return usageFailure(monthly.message);
  }

  const weekly = await weeklyPromise;
  const weeklyJson = weekly !== null && weekly.ok ? weekly.json : undefined;
  return parseXaiUsagePayloads(
    Value.Check(XaiPayloadSchema, monthly.json)
      ? Value.Parse(XaiPayloadSchema, monthly.json)
      : undefined,
    weeklyJson !== undefined && Value.Check(XaiPayloadSchema, weeklyJson)
      ? Value.Parse(XaiPayloadSchema, weeklyJson)
      : undefined,
    now(),
  );
};
