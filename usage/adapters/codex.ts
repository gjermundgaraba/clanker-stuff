import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveOAuthAccess } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow, UsageWindowId } from "../types.js";
import { usageFailure, usageResult } from "../types.js";
import type { AdapterDeps } from "./util.js";
import {
  isDefined,
  makeUsageWindow,
  windowIdFromLimitSeconds,
} from "./util.js";

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
    const padded =
      payload.length % 4 === 0
        ? payload
        : `${payload}${"=".repeat(4 - (payload.length % 4))}`;
    const json = Buffer.from(
      padded.replaceAll("-", "+").replaceAll("_", "/"),
      "base64"
    ).toString("utf-8");
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

const NullableCodexRateLimitWindowSchema = Type.Union([
  CodexRateLimitWindowSchema,
  Type.Null(),
]);

const CodexUsagePayloadSchema = Type.Object({
  credits: Type.Optional(
    Type.Object({
      balance: Type.Optional(
        Type.Union([Type.Number(), Type.String(), Type.Null()])
      ),
      has_credits: Type.Optional(Type.Boolean()),
    })
  ),
  plan_type: Type.Optional(Type.String()),
  rate_limit: Type.Optional(
    Type.Object({
      primary_window: Type.Optional(NullableCodexRateLimitWindowSchema),
      secondary_window: Type.Optional(NullableCodexRateLimitWindowSchema),
    })
  ),
});

type CodexRateLimitWindow = Static<typeof CodexRateLimitWindowSchema>;

const mapWindow = (
  window: CodexRateLimitWindow | null | undefined,
  fallbackId: UsageWindowId,
  nowMs: number
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

export const parseCodexUsagePayload = (
  payload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(CodexUsagePayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  const windows = [
    mapWindow(payload.rate_limit?.primary_window, "5h", nowMs),
    mapWindow(payload.rate_limit?.secondary_window, "7d", nowMs),
  ].filter(isDefined);

  const planLabel = payload.plan_type;
  const rawCreditsBalance = payload.credits?.balance;
  const parsedCreditsBalance =
    typeof rawCreditsBalance === "string" && rawCreditsBalance.trim() !== ""
      ? Number(rawCreditsBalance)
      : rawCreditsBalance;
  const creditsRemaining =
    payload.credits?.has_credits === true &&
    typeof parsedCreditsBalance === "number" &&
    Number.isFinite(parsedCreditsBalance)
      ? parsedCreditsBalance
      : undefined;

  return usageResult({
    fetchedAt: nowMs,
    provider: "openai-codex",
    windows,
    ...(planLabel === undefined ? {} : { planLabel }),
    ...(creditsRemaining === undefined ? {} : { creditsRemaining }),
  });
};

export const fetchCodexUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveOAuthAccess(deps.authClient, "openai-codex");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const accountId = extractChatGptAccountId(auth.value.accessToken);
  if (accountId === undefined) {
    return usageFailure("missing ChatGPT account id in token");
  }

  const response = await deps.fetchJson(WHAM_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.value.accessToken}`,
      "ChatGPT-Account-Id": accountId,
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseCodexUsagePayload(response.json, now());
  }

  return usageFailure(response.message);
};
