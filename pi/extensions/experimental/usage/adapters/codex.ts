import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { durationLabel, fetchUsage, isDefined, isoFromEpochMs, makeUsageWindow } from "./util.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const CodexClaimsSchema = Type.Object({
  "https://api.openai.com/auth": Type.Object({
    chatgpt_account_id: Type.String({ minLength: 1 }),
  }),
});

const CodexWindowSchema = Type.Object({
  used_percent: Type.Number(),
  limit_window_seconds: Type.Integer({ minimum: 1 }),
  reset_at: Type.Optional(Type.Number()),
});

const CodexRateLimitSchema = Type.Object({
  primary_window: Type.Optional(Type.Union([CodexWindowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([CodexWindowSchema, Type.Null()])),
});

const CodexUsageSchema = Type.Object({
  plan_type: Type.Optional(Type.String()),
  credits: Type.Optional(
    Type.Union([
      Type.Object({
        has_credits: Type.Optional(Type.Boolean()),
        unlimited: Type.Optional(Type.Boolean()),
        balance: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
  rate_limit: Type.Optional(Type.Union([CodexRateLimitSchema, Type.Null()])),
  additional_rate_limits: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          limit_name: Type.String({ minLength: 1 }),
          rate_limit: Type.Optional(Type.Union([CodexRateLimitSchema, Type.Null()])),
        }),
      ),
      Type.Null(),
    ]),
  ),
});

type CodexUsage = Static<typeof CodexUsageSchema>;

/** Codex routes requests by the account claim in Pi's resolved token. */
const accountHeaders = (token: string): Record<string, string> => {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );

    return Value.Check(CodexClaimsSchema, claims)
      ? { "ChatGPT-Account-Id": claims["https://api.openai.com/auth"].chatgpt_account_id }
      : {};
  } catch {
    return {};
  }
};

const parseWindows = (
  limit: Static<typeof CodexRateLimitSchema> | null | undefined,
  bucket?: string,
): UsageWindow[] =>
  [limit?.primary_window, limit?.secondary_window]
    .map((window) => {
      if (window === undefined || window === null) return undefined;

      const duration = durationLabel(window.limit_window_seconds);

      return makeUsageWindow(
        bucket === undefined ? duration : `${bucket} ${duration}`,
        100 - window.used_percent,
        isoFromEpochMs(window.reset_at === undefined ? undefined : window.reset_at * 1000),
      );
    })
    .filter(isDefined);

/** Like Codex itself, show a balance only for metered credits and ignore one that does not parse. */
const creditBalance = (credits: CodexUsage["credits"]): number | undefined => {
  if (credits?.has_credits !== true || credits.unlimited === true) return undefined;

  const balance = credits.balance?.trim();
  const available = Number(balance);

  return balance === undefined || balance === "" || !Number.isFinite(available)
    ? undefined
    : available;
};

export const mapCodexUsagePayload = (payload: CodexUsage, nowMs: number): UsageFetchResult => {
  const available = creditBalance(payload.credits);

  const additionalQuotaWindows = (payload.additional_rate_limits ?? []).flatMap((limit) =>
    parseWindows(limit.rate_limit, limit.limit_name),
  );

  return usageResult({
    fetchedAt: nowMs,
    provider: "openai-codex",
    ...(payload.plan_type === undefined ? {} : { planLabel: payload.plan_type }),
    quotaWindows: parseWindows(payload.rate_limit),
    ...(additionalQuotaWindows.length === 0 ? {} : { additionalQuotaWindows }),
    ...(available === undefined ? {} : { accounting: { kind: "credit-balance", available } }),
  });
};

export const fetchCodexUsage = (deps: AdapterDeps): Promise<UsageFetchResult> =>
  fetchUsage(
    deps,
    "openai-codex",
    {
      url: CODEX_USAGE_URL,
      schema: CodexUsageSchema,
      oauth: true,
      headers: (token) => ({ ...accountHeaders(token), "User-Agent": "pi-usage" }),
    },
    mapCodexUsagePayload,
  );
