import { Type } from "typebox";
import type { Static } from "typebox";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import type { AdapterDeps } from "./util.js";
import { fetchBearerUsage, isDefined, makeUsageWindow, parseIso } from "./util.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const OpenCodeGoWindowSchema = Type.Object({
  percent: Type.Number({ maximum: 100, minimum: 0 }),
  resetsAt: Type.Optional(Type.String()),
});

const OpenCodeGoUsagePayloadSchema = Type.Object({
  usage: Type.Object({
    monthly: Type.Optional(OpenCodeGoWindowSchema),
    rolling: Type.Optional(OpenCodeGoWindowSchema),
    weekly: Type.Optional(OpenCodeGoWindowSchema),
  }),
});

const parseWindow = (
  raw: Static<typeof OpenCodeGoWindowSchema> | undefined,
  id: UsageWindow["id"],
): UsageWindow | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  return makeUsageWindow(id, 100 - raw.percent, parseIso(raw.resetsAt));
};

export const mapOpenCodeGoUsagePayload = (
  payload: Static<typeof OpenCodeGoUsagePayloadSchema>,
  nowMs: number = Date.now(),
): UsageFetchResult => {
  const windows = [
    parseWindow(payload.usage.rolling, "5h"),
    parseWindow(payload.usage.weekly, "7d"),
    parseWindow(payload.usage.monthly, "month"),
  ].filter(isDefined);

  return usageResult({ fetchedAt: nowMs, provider: "opencode-go", quotaWindows: windows });
};

export const fetchOpenCodeGoUsage = (deps: AdapterDeps): Promise<UsageFetchResult> =>
  fetchBearerUsage(
    deps,
    "opencode-go",
    OPENCODE_GO_USAGE_URL,
    OpenCodeGoUsagePayloadSchema,
    mapOpenCodeGoUsagePayload,
  );
