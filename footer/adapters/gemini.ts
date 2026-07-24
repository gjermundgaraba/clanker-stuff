import { Type } from "typebox";
import { Value } from "typebox/value";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult } from "../types.js";
import { usageFailure, usageResult } from "../types.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow } from "./util.js";

const GEMINI_QUOTA_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

const GeminiUsagePayloadSchema = Type.Object({
  buckets: Type.Optional(
    Type.Array(
      Type.Object({
        modelId: Type.String(),
        remainingFraction: Type.Number(),
      })
    )
  ),
});

export const parseGeminiUsagePayload = (
  payload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(GeminiUsagePayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  // One bucket per model; keep the tightest remaining fraction per family.
  let proMin: number | undefined;
  let flashMin: number | undefined;
  for (const bucket of payload.buckets ?? []) {
    const lower = bucket.modelId.toLowerCase();
    if (lower.includes("pro")) {
      proMin =
        proMin === undefined
          ? bucket.remainingFraction
          : Math.min(proMin, bucket.remainingFraction);
    }
    if (lower.includes("flash")) {
      flashMin =
        flashMin === undefined
          ? bucket.remainingFraction
          : Math.min(flashMin, bucket.remainingFraction);
    }
  }

  const windows = [
    proMin === undefined
      ? undefined
      : makeUsageWindow("day", proMin * 100, undefined, "Pro"),
    flashMin === undefined
      ? undefined
      : makeUsageWindow("day", flashMin * 100, undefined, "Flash"),
  ].filter(isDefined);

  return usageResult({
    fetchedAt: nowMs,
    provider: "google-gemini-cli",
    windows,
  });
};

export const fetchGeminiUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "google-gemini-cli");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(GEMINI_QUOTA_URL, {
    body: "{}",
    headers: {
      Authorization: `Bearer ${auth.value.accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseGeminiUsagePayload(response.json, now());
  }

  return usageFailure(response.message);
};
