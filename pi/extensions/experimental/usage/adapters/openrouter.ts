import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { fetchBearerUsage } from "./util.js";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

const OpenRouterCreditsPayloadSchema = Type.Object({
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

export const fetchOpenRouterUsage = (deps: AdapterDeps): Promise<UsageFetchResult> =>
  fetchBearerUsage(
    deps,
    "openrouter",
    OPENROUTER_CREDITS_URL,
    OpenRouterCreditsPayloadSchema,
    mapOpenRouterCreditsPayload,
  );
