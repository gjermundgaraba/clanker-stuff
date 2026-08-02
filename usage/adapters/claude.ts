import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveAccessToken } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { UsageFetchResult, UsageWindow } from "../types.js";
import { usageFailure, usageResult } from "../types.js";
import type { AdapterDeps } from "./util.js";
import { isDefined, makeUsageWindow, parseIso } from "./util.js";

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
  id: UsageWindow["id"]
): UsageWindow | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  return makeUsageWindow(id, 100 - raw.utilization, parseIso(raw.resets_at));
};

export const parseClaudeUsagePayload = (
  payload: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(ClaudeUsagePayloadSchema, payload)) {
    return usageFailure("invalid usage payload");
  }

  const windows = [
    parseWindow(payload.five_hour, "5h"),
    parseWindow(payload.seven_day, "week"),
  ].filter(isDefined);

  return usageResult({
    fetchedAt: nowMs,
    provider: "anthropic",
    windows,
  });
};

export const fetchClaudeUsage = async (
  deps: AdapterDeps
): Promise<UsageFetchResult> => {
  const now = deps.now ?? Date.now;
  const auth = await resolveAccessToken(deps.authClient, "anthropic");
  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.value.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return parseClaudeUsagePayload(response.json, now());
  }

  return usageFailure(response.message);
};
