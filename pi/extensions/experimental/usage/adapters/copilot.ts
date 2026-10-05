import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { fetchUsage, isDefined, makeUsageWindow, parseIso } from "./util.js";

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
    }),
  ),
});

const parseQuotaWindow = (
  quota: Static<typeof CopilotQuotaSchema> | undefined,
  label: string,
  resetsAt: string | undefined,
): UsageWindow | undefined => {
  if (quota === undefined || quota.unlimited === true || quota.percent_remaining === undefined) {
    return undefined;
  }

  return makeUsageWindow("month", quota.percent_remaining, resetsAt, label);
};

export const mapCopilotUsagePayload = (
  payload: Static<typeof CopilotUsagePayloadSchema>,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const resetsAt = parseIso(payload.quota_reset_date_utc);

  const windows = [
    parseQuotaWindow(payload.quota_snapshots?.premium_interactions, "Premium", resetsAt),
    parseQuotaWindow(payload.quota_snapshots?.chat, "Chat", resetsAt),
  ].filter(isDefined);

  return usageResult({ fetchedAt: nowMs, provider: "github-copilot", quotaWindows: windows });
};

export const fetchCopilotUsage = (deps: AdapterDeps): Promise<UsageFetchResult> =>
  fetchUsage(
    deps,
    "github-copilot",
    {
      url: COPILOT_USAGE_URL,
      schema: CopilotUsagePayloadSchema,
      scheme: "token",
      headers: {
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    },
    mapCopilotUsagePayload,
  );
