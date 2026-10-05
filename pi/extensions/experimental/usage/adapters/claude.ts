import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { fetchUsage, isDefined, makeUsageWindow, parseIso } from "./util.js";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const ClaudeWindowSchema = Type.Object({
  resets_at: Type.Optional(Type.String()),
  utilization: Type.Number({ maximum: 100, minimum: 0 }),
});

const ClaudeUsagePayloadSchema = Type.Object({
  five_hour: Type.Optional(ClaudeWindowSchema),
  seven_day: Type.Optional(ClaudeWindowSchema),
});

const parseWindow = (
  raw: Static<typeof ClaudeWindowSchema> | undefined,
  id: UsageWindow["id"],
): UsageWindow | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  return makeUsageWindow(id, 100 - raw.utilization, parseIso(raw.resets_at));
};

export const mapClaudeUsagePayload = (
  payload: Static<typeof ClaudeUsagePayloadSchema>,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const windows = [
    parseWindow(payload.five_hour, "5h"),
    parseWindow(payload.seven_day, "week"),
  ].filter(isDefined);

  return usageResult({ fetchedAt: nowMs, provider: "anthropic", quotaWindows: windows });
};

export const fetchClaudeUsage = (deps: AdapterDeps): Promise<UsageFetchResult> =>
  fetchUsage(
    deps,
    "anthropic",
    {
      url: CLAUDE_USAGE_URL,
      schema: ClaudeUsagePayloadSchema,
      oauth: true,
      headers: { "anthropic-beta": "oauth-2025-04-20" },
    },
    mapClaudeUsagePayload,
  );
