import type { UsageFetchResult, UsageWindow } from "../providers.js";
import { usageResult } from "../providers.js";
import { isDefined, isoFromEpochMs, makeUsageWindow } from "./util.js";

const HEADER_PREFIX = "anthropic-ratelimit-unified";

const headerNumber = (
  headers: Readonly<Record<string, string>>,
  name: string
): number | undefined => {
  const raw = headers[`${HEADER_PREFIX}-${name}`];

  const value =
    raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);

  return Number.isFinite(value) ? value : undefined;
};

const headerWindow = (
  headers: Readonly<Record<string, string>>,
  header: string,
  label: string
): UsageWindow | undefined => {
  const utilization = headerNumber(headers, `${header}-utilization`);

  if (utilization === undefined) {
    return undefined;
  }

  const resetsAt = headerNumber(headers, `${header}-reset`);

  return makeUsageWindow(
    label,
    100 - utilization * 100,
    resetsAt === undefined ? undefined : isoFromEpochMs(resetsAt * 1000)
  );
};

/** claude-bridge's plan usage from the `anthropic-ratelimit-unified-*` headers it reports
 *  through `after_provider_response`: utilization is a fraction and resets are Unix
 *  seconds, as the Anthropic API sends them. */
export const mapClaudeBridgeHeaders = (
  headers: Readonly<Record<string, string>>,
  nowMs: number
): UsageFetchResult =>
  usageResult({
    fetchedAt: nowMs,
    provider: "claude-bridge",
    quotaWindows: [
      headerWindow(headers, "5h", "5h"),
      headerWindow(headers, "7d", "week"),
    ].filter(isDefined),
  });
