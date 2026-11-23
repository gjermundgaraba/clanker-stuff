import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderResponse } from "@earendil-works/pi-ai";

/** The `after_provider_response` header claude-bridge reports Claude Code's plan usage
 *  in, so a reader knows the usage is claude-bridge's whichever model is selected. */
export const PLAN_USAGE_HEADER = "x-claude-bridge-plan-usage";

/** Claude Code's plan usage as a response carrying {@link PLAN_USAGE_HEADER}, or nothing
 *  when the event has none. A `rate_limit_event` carries every window Claude Code knows
 *  in an undeclared `unifiedWindows` field, sent on as its JSON: keyed by window name,
 *  utilization as a fraction and resets in Unix seconds. The reader checks its shape. */
export const planUsageResponse = (
  info: SDKRateLimitInfo
): ProviderResponse | undefined => {
  const windows = "unifiedWindows" in info ? info.unifiedWindows : undefined;

  return windows === undefined
    ? undefined
    : {
        status: 200,
        headers: { [PLAN_USAGE_HEADER]: JSON.stringify(windows) },
      };
};
