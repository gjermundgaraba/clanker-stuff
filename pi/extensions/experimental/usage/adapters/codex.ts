import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveOAuthAccess } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type {
  UsageFetchResult,
  UsageLimit,
  UsageSnapshot,
  UsageWindow,
  UsageWindowId,
} from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow, windowIdFromLimitSeconds } from "./util.js";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

const ChatGptTokenPayloadSchema = Type.Object({
  [OPENAI_AUTH_CLAIM]: Type.Object({
    chatgpt_account_id: Type.String({ minLength: 1 }),
  }),
});

const extractChatGptAccountId = (accessToken: string): string | undefined => {
  const [, payload] = accessToken.split(".");
  if (payload === undefined) {
    return undefined;
  }

  try {
    const json = Buffer.from(payload, "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    return Value.Check(ChatGptTokenPayloadSchema, parsed)
      ? parsed[OPENAI_AUTH_CLAIM].chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
};

const CodexRateLimitWindowSchema = Type.Object({
  limit_window_seconds: Type.Optional(Type.Number()),
  reset_after_seconds: Type.Optional(Type.Number()),
  used_percent: Type.Number(),
});

const NullableCodexRateLimitWindowSchema = Type.Union([CodexRateLimitWindowSchema, Type.Null()]);
const CodexRateLimitSchema = Type.Object({
  allowed: Type.Optional(Type.Boolean()),
  primary_window: Type.Optional(NullableCodexRateLimitWindowSchema),
  secondary_window: Type.Optional(NullableCodexRateLimitWindowSchema),
});
const NullableCodexRateLimitSchema = Type.Union([CodexRateLimitSchema, Type.Null()]);

const CodexUsagePayloadSchema = Type.Object({
  additional_rate_limits: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          limit_name: Type.String(),
          metered_feature: Type.String(),
          normal_model_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          rate_limit: Type.Optional(NullableCodexRateLimitSchema),
        }),
      ),
      Type.Null(),
    ]),
  ),
  credits: Type.Optional(
    Type.Union([
      Type.Object({
        balance: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
        has_credits: Type.Optional(Type.Boolean()),
      }),
      Type.Null(),
    ]),
  ),
  plan_type: Type.Optional(Type.String()),
  rate_limit: Type.Optional(NullableCodexRateLimitSchema),
});

type CodexRateLimitWindow = Static<typeof CodexRateLimitWindowSchema>;

const mapWindow = (
  window: CodexRateLimitWindow | null | undefined,
  fallbackId: UsageWindowId,
  nowMs: number,
): UsageWindow | undefined => {
  if (window === null || window === undefined) {
    return undefined;
  }
  const remainingPercent = 100 - window.used_percent;
  const limitSeconds = window.limit_window_seconds;
  const id =
    limitSeconds === undefined
      ? fallbackId
      : (windowIdFromLimitSeconds(limitSeconds) ?? fallbackId);
  const resetsAt =
    window.reset_after_seconds === undefined
      ? undefined
      : new Date(nowMs + window.reset_after_seconds * 1000).toISOString();
  return makeUsageWindow(id, remainingPercent, resetsAt);
};

export const mapCodexUsagePayload = (
  payload: Static<typeof CodexUsagePayloadSchema>,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const windows = [
    mapWindow(payload.rate_limit?.primary_window, "5h", nowMs),
    mapWindow(payload.rate_limit?.secondary_window, "7d", nowMs),
  ].filter(isDefined);

  const planLabel = payload.plan_type;
  let creditsRemaining: number | undefined = undefined;
  if (payload.credits?.has_credits === true) {
    const balance = payload.credits.balance;
    if (typeof balance === "number" && Number.isFinite(balance)) {
      creditsRemaining = balance;
    } else if (typeof balance === "string" && balance.trim() !== "") {
      const converted = Number(balance);
      creditsRemaining = Number.isFinite(converted) ? converted : undefined;
    }
  }

  const snapshot: UsageSnapshot = {
    fetchedAt: nowMs,
    provider: "openai-codex",
    windows,
  };
  if (payload.rate_limit?.allowed !== undefined) {
    snapshot.ordinaryUsageAllowed = payload.rate_limit.allowed;
  }
  if (payload.additional_rate_limits != null) {
    snapshot.additionalLimits = payload.additional_rate_limits.map((limit): UsageLimit => {
      const result: UsageLimit = {
        id: limit.metered_feature,
        label: limit.limit_name,
        windows: [
          mapWindow(limit.rate_limit?.primary_window, "5h", nowMs),
          mapWindow(limit.rate_limit?.secondary_window, "7d", nowMs),
        ].filter(isDefined),
      };
      if (limit.normal_model_slug != null) {
        result.model = limit.normal_model_slug;
      }
      if (limit.rate_limit?.allowed !== undefined) {
        result.allowed = limit.rate_limit.allowed;
      }
      return result;
    });
  }
  if (planLabel !== undefined) {
    snapshot.planLabel = planLabel;
  }
  if (creditsRemaining !== undefined) {
    snapshot.creditsRemaining = creditsRemaining;
  }
  return usageResult(snapshot);
};

export const fetchCodexUsage = async (deps: AdapterDeps): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveOAuthAccess(deps.authClient, "openai-codex");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const accountId = extractChatGptAccountId(auth.value.accessToken);
  if (accountId === undefined) {
    return usageFailure("missing ChatGPT account id in token");
  }

  const response = await deps.fetchJson(WHAM_USAGE_URL, CodexUsagePayloadSchema, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.value.accessToken}`,
      "ChatGPT-Account-Id": accountId,
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return mapCodexUsagePayload(response.json, now());
  }

  return usageFailure(response.message);
};
