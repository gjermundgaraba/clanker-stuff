import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow } from "../types.js";
import { usageFailure, usageResult } from "../types.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow, parseIso } from "./util.js";

const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

const CopilotQuotaSchema = Type.Object({
  percent_remaining: Type.Optional(Type.Number()),
  unlimited: Type.Optional(Type.Boolean()),
});

const CopilotUsagePayloadSchema = Type.Object({
  quota_reset_date_utc: Type.Optional(Type.String()),
  quota_snapshots: Type.Optional(
    Type.Object({
      chat: Type.Optional(CopilotQuotaSchema),
      premium_interactions: Type.Optional(CopilotQuotaSchema),
    })
  ),
});

const parseQuotaWindow = (
  quota: Static<typeof CopilotQuotaSchema> | undefined,
  label: string,
  resetsAt: string | undefined
): UsageWindow | undefined => {
  if (
    quota === undefined ||
    quota.unlimited === true ||
    quota.percent_remaining === undefined
  ) {
    return undefined;
  }
  return makeUsageWindow("month", quota.percent_remaining, resetsAt, label);
};

export const parseCopilotUsagePayload = (
  payload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(CopilotUsagePayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  const resetsAt = parseIso(payload.quota_reset_date_utc);
  const windows = [
    parseQuotaWindow(
      payload.quota_snapshots?.premium_interactions,
      "Premium",
      resetsAt
    ),
    parseQuotaWindow(payload.quota_snapshots?.chat, "Chat", resetsAt),
  ].filter(isDefined);

  return usageResult({
    fetchedAt: nowMs,
    provider: "github-copilot",
    windows,
  });
};

export const fetchCopilotUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "github-copilot");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(COPILOT_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `token ${auth.value.accessToken}`,
      "Editor-Version": "vscode/1.96.2",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseCopilotUsagePayload(response.json, now());
  }

  return usageFailure(response.message);
};
