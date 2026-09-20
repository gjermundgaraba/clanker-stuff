import { Type } from "typebox";
import type { Static } from "typebox";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult } from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export const OpenRouterCreditsPayloadSchema = Type.Object({
  data: Type.Object({
    total_credits: Type.Number(),
    total_usage: Type.Number(),
  }),
});

export const mapOpenRouterCreditsPayload = (
  payload: Static<typeof OpenRouterCreditsPayloadSchema>,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const available = payload.data.total_credits - payload.data.total_usage;

  return usageResult({
    accounting: { available, kind: "credit-balance" },
    fetchedAt: nowMs,
    provider: "openrouter",
    quotaWindows: [],
  });
};

export const fetchOpenRouterUsage = async (deps: AdapterDeps): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "openrouter");

  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(OPENROUTER_CREDITS_URL, OpenRouterCreditsPayloadSchema, {
    headers: {
      Authorization: `Bearer ${auth.value.accessToken}`,
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return mapOpenRouterCreditsPayload(response.json, now());
  }

  return usageFailure(response.message);
};
