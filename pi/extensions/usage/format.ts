import { providerDisplayName } from "./providers.js";
import type {
  SupportedProvider,
  UsageSnapshot,
  UsageWindow,
  UsageWindowId,
} from "./providers.js";

const WINDOW_ORDER: Record<UsageWindowId, number> = {
  "5h": 0,
  "7d": 2,
  day: 1,
  month: 4,
  week: 3,
};

const orderWindows = (windows: UsageWindow[]): UsageWindow[] =>
  windows.toSorted(
    (left, right) => WINDOW_ORDER[left.id] - WINDOW_ORDER[right.id]
  );

export const sanitizeUsageText = (value: string): string =>
  value.replaceAll(/\p{Cc}/gu, "");

export const formatResetDuration = (
  resetsAt: string,
  nowMs: number = Date.now()
): string => {
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) {
    return "unknown";
  }
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) {
    return "now";
  }

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
};

const formatAge = (fetchedAt: number, nowMs: number = Date.now()): string => {
  const ageMs = Math.max(0, nowMs - fetchedAt);
  if (ageMs < 1000) {
    return "just now";
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const formatCreditsAmount = (value: number): string => {
  if (Number.isInteger(value)) {
    return String(value);
  }
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
};

export const formatDetail = (
  snapshot: UsageSnapshot,
  nowMs: number = Date.now()
): string => {
  const lines: string[] = [];
  const title = providerDisplayName(snapshot.provider);
  const plan =
    snapshot.planLabel === undefined || snapshot.planLabel.length === 0
      ? ""
      : ` (${sanitizeUsageText(snapshot.planLabel)})`;
  lines.push(`${title}${plan}`);

  for (const window of orderWindows(snapshot.windows)) {
    const reset =
      window.resetsAt === undefined || window.resetsAt.length === 0
        ? "resets unknown"
        : `resets in ${formatResetDuration(window.resetsAt, nowMs)}`;
    lines.push(
      `${sanitizeUsageText(window.label)}  ${Math.round(window.remainingPercent)}% left  ${reset}`
    );
  }

  if (snapshot.creditsRemaining !== undefined) {
    lines.push(`credits  ${formatCreditsAmount(snapshot.creditsRemaining)}`);
  }

  return lines.join("\n");
};

export const formatProviderError = (
  provider: SupportedProvider,
  message: string
): string => `usage: ${provider}: ${sanitizeUsageText(message)}`;

export const formatRefreshFailed = (
  provider: SupportedProvider,
  message: string,
  fetchedAt: number,
  nowMs: number = Date.now()
): string =>
  `usage: ${provider}: refresh failed (${sanitizeUsageText(message)}); showing cached data from ${formatAge(fetchedAt, nowMs)}`;
