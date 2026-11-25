import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import { isDefined, isoFromEpochMs, makeUsageWindow } from "./util.js";

export const CLAUDE_BRIDGE_PLAN_USAGE_HEADER = "x-claude-bridge-plan-usage";

const WindowSchema = Type.Object({
  utilization: Type.Number(),
  resetsAt: Type.Optional(Type.Number()),
});

const PlanUsageSchema = Type.Object({
  five_hour: Type.Optional(Type.Unknown()),
  seven_day: Type.Optional(Type.Unknown()),
});

const readPlanUsage = (raw: string): Static<typeof PlanUsageSchema> => {
  try {
    const parsed: unknown = JSON.parse(raw);

    return Value.Check(PlanUsageSchema, parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const planWindow = (window: unknown, label: string): UsageWindow | undefined =>
  Value.Check(WindowSchema, window)
    ? makeUsageWindow(
        label,
        100 - window.utilization * 100,
        window.resetsAt === undefined
          ? undefined
          : isoFromEpochMs(window.resetsAt * 1000)
      )
    : undefined;

/** claude-bridge's plan usage from a response's headers, or nothing when the response
 *  is not claude-bridge's. Utilization is a fraction and resets are Unix seconds. */
export const mapClaudeBridgePlanUsage = (
  headers: Readonly<Record<string, string>>,
  nowMs: number
): UsageFetchResult | undefined => {
  const raw = headers[CLAUDE_BRIDGE_PLAN_USAGE_HEADER];

  if (raw === undefined) {
    return undefined;
  }

  const usage = readPlanUsage(raw);

  return usageResult({
    fetchedAt: nowMs,
    provider: "claude-bridge",
    quotaWindows: [
      planWindow(usage.five_hour, "5h"),
      planWindow(usage.seven_day, "week"),
    ].filter(isDefined),
  });
};
