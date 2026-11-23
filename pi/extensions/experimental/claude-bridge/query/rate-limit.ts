import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderResponse } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

const HEADER_PREFIX = "anthropic-ratelimit-unified";

const WINDOW_HEADER_NAMES = new Map([
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_overage_included", "7d_oi"],
]);

const UnifiedWindowsSchema = Type.Record(
  Type.String(),
  Type.Object({
    utilization: Type.Optional(Type.Number()),
    resetsAt: Type.Optional(Type.Number()),
  })
);

const unifiedWindows = (info: SDKRateLimitInfo) => {
  const windows = "unifiedWindows" in info ? info.unifiedWindows : undefined;

  return Value.Check(UnifiedWindowsSchema, windows) ? windows : {};
};

/** Claude Code's plan usage as the `anthropic-ratelimit-unified-*` headers the Anthropic
 *  API sends, so what reads them from pi's `anthropic` provider reads the bridge too. A
 *  `rate_limit_event` carries every window Claude Code knows in an undeclared
 *  `unifiedWindows` field: utilization as a fraction and resets in Unix seconds, as the
 *  headers have them. The status is always 200: a rejected window can still be served
 *  from overage, so only the status header says whether it was. */
export const rateLimitResponse = (info: SDKRateLimitInfo): ProviderResponse => {
  const headers: Record<string, string> = {};

  const set = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) {
      headers[`${HEADER_PREFIX}-${name}`] = String(value);
    }
  };

  set("status", info.status);
  set("reset", info.resetsAt);
  set("representative-claim", info.rateLimitType);
  set("overage-status", info.overageStatus);
  set("overage-reset", info.overageResetsAt);

  for (const [name, window] of Object.entries(unifiedWindows(info))) {
    const header = WINDOW_HEADER_NAMES.get(name) ?? name;

    set(`${header}-utilization`, window.utilization);
    set(`${header}-reset`, window.resetsAt);
  }

  return { status: 200, headers };
};
