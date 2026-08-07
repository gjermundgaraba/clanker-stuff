import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow } from "./util.js";

const MINIMAX_USAGE_URL = "https://api.minimax.io/v1/token_plan/remains";
const MINIMAX_CN_USAGE_URL = "https://api.minimaxi.com/v1/token_plan/remains";

const MinimaxBucketSchema = Type.Object({
  current_interval_remaining_percent: Type.Optional(Type.Number()),
  current_interval_status: Type.Optional(Type.Number()),
  current_weekly_remaining_percent: Type.Optional(Type.Number()),
  end_time: Type.Optional(Type.Number()),
  model_name: Type.Optional(Type.String()),
  weekly_end_time: Type.Optional(Type.Number()),
});

const MinimaxUsagePayloadSchema = Type.Object({
  base_resp: Type.Optional(
    Type.Object({
      status_code: Type.Optional(Type.Number()),
      status_msg: Type.Optional(Type.String()),
    })
  ),
  model_remains: Type.Optional(Type.Array(MinimaxBucketSchema)),
});

type MinimaxBucket = Static<typeof MinimaxBucketSchema>;

const epochMsToIso = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : new Date(value).toISOString();

/** Bucket selection: prefer the active "general" bucket (text/code), then any
 *  general bucket, then any active bucket, then the first bucket. */
const pickBucket = (remains: MinimaxBucket[]): MinimaxBucket | undefined =>
  remains.find(
    (entry) =>
      entry.model_name === "general" && entry.current_interval_status === 1
  ) ??
  remains.find((entry) => entry.model_name === "general") ??
  remains.find((entry) => entry.current_interval_status === 1) ??
  remains[0];

const remainingWindow = (
  remainingPercent: number | undefined,
  resetsAt: string | undefined,
  id: UsageWindow["id"]
): UsageWindow | undefined => {
  if (remainingPercent === undefined) {
    return undefined;
  }
  return makeUsageWindow(id, remainingPercent, resetsAt);
};

export const parseMinimaxUsagePayload = (
  payload: unknown,
  provider: "minimax" | "minimax-cn",
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(MinimaxUsagePayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  const statusCode = payload.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    const statusMessage =
      payload.base_resp?.status_msg !== undefined &&
      payload.base_resp.status_msg.length > 0
        ? payload.base_resp.status_msg
        : `API ${statusCode}`;
    return usageFailure(statusMessage);
  }

  const bucket = pickBucket(payload.model_remains ?? []);
  const windows =
    bucket === undefined
      ? []
      : [
          remainingWindow(
            bucket.current_interval_remaining_percent,
            epochMsToIso(bucket.end_time),
            "5h"
          ),
          remainingWindow(
            bucket.current_weekly_remaining_percent,
            epochMsToIso(bucket.weekly_end_time),
            "week"
          ),
        ].filter(isDefined);

  return usageResult({
    fetchedAt: nowMs,
    provider,
    windows,
  });
};

export const fetchMinimaxUsage = async (
  deps: AdapterDeps,
  provider: "minimax" | "minimax-cn"
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, provider);
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const url =
    provider === "minimax-cn" ? MINIMAX_CN_USAGE_URL : MINIMAX_USAGE_URL;
  const response = await deps.fetchJson(url, {
    headers: {
      Authorization: `Bearer ${auth.value.accessToken}`,
      "Content-Type": "application/json",
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseMinimaxUsagePayload(response.json, provider, now());
  }

  return usageFailure(response.message);
};
