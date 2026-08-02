import type { ProviderAuthClient } from "../auth.js";
import type { FetchJson } from "../http.js";
import type { UsageWindow, UsageWindowId } from "../types.js";

export interface AdapterDeps {
  authClient: ProviderAuthClient;
  fetchJson: FetchJson;
  now?: () => number;
}

export const isDefined = <T>(value: T | undefined): value is T =>
  value !== undefined;

const clampPercent = (value: number): number =>
  Math.min(100, Math.max(0, value));

export const makeUsageWindow = (
  id: UsageWindowId,
  remainingPercent: number,
  resetsAt?: string,
  label: string = id
): UsageWindow => ({
  id,
  label,
  remainingPercent: clampPercent(remainingPercent),
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

export const parseIso = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
};

/**
 * Map a window length in seconds to a coarse bucket. 5h class accepts up to
 * 12h rolling windows; 7d class accepts multi-day through ~2 weeks.
 */
export const windowIdFromLimitSeconds = (
  seconds: number
): UsageWindowId | undefined => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  if (seconds <= 12 * 3600) {
    return "5h";
  }
  if (seconds <= 14 * 86_400) {
    return "7d";
  }
  return "month";
};
