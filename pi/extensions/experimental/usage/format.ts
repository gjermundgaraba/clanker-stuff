import { providerDisplayName } from "./providers.js";
import type {
  SupportedProvider,
  UsageAccounting,
  UsageSnapshot,
  UsageWindow,
  UsageWindowId,
} from "./providers.js";

const WINDOW_ORDER = {
  "5h": 0,
  "7d": 2,
  day: 1,
  month: 4,
  week: 3,
} satisfies Record<UsageWindowId, number>;

const USD_FORMAT = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
});

const CREDIT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const orderWindows = (windows: UsageWindow[]): UsageWindow[] =>
  windows.toSorted((left, right) => WINDOW_ORDER[left.id] - WINDOW_ORDER[right.id]);

export const sanitizeUsageText = (value: string): string => value.replaceAll(/\p{Cc}/gu, "");

export const formatResetDuration = (resetsAt: string, nowMs: number = Date.now()): string => {
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

  if (ageMs < 1000) return "just now";
  const seconds = Math.floor(ageMs / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);

  if (hours < 48) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
};

export const formatUsd = (value: number): string => USD_FORMAT.format(value);

export const formatCredits = (value: number): string => CREDIT_FORMAT.format(value);

const accountingLines = (accounting: UsageAccounting, nowMs: number): string[] =>
  accounting.kind === "credit-balance"
    ? [`credits  ${formatCredits(accounting.available)}`]
    : [
        `available  ${formatUsd(accounting.available)}`,
        `balance  ${formatUsd(accounting.balance)}`,
        `reserved  ${formatUsd(accounting.reserved)}`,
        `month spend  ${formatUsd(accounting.currentMonthSpend)}  ends in ${formatResetDuration(accounting.periodEndsAt, nowMs)}`,
      ];

export const formatDetail = (snapshot: UsageSnapshot, nowMs: number = Date.now()): string => {
  const lines: string[] = [];
  const title = providerDisplayName(snapshot.provider);

  const plan =
    snapshot.planLabel === undefined || snapshot.planLabel.length === 0
      ? ""
      : ` (${sanitizeUsageText(snapshot.planLabel)})`;

  lines.push(`${title}${plan}`);

  if (snapshot.ordinaryUsageAllowed !== undefined) {
    lines.push(`ordinary usage  ${snapshot.ordinaryUsageAllowed ? "allowed" : "unavailable"}`);
  }

  for (const window of orderWindows(snapshot.quotaWindows)) {
    const reset =
      window.resetsAt === undefined || window.resetsAt.length === 0
        ? "resets unknown"
        : `resets in ${formatResetDuration(window.resetsAt, nowMs)}`;

    lines.push(
      `${sanitizeUsageText(window.label)}  ${Math.round(window.remainingPercent)}% left  ${reset}`,
    );
  }

  if (snapshot.accounting !== undefined) {
    lines.push(...accountingLines(snapshot.accounting, nowMs));
  }

  return lines.join("\n");
};

export const formatProviderError = (provider: SupportedProvider, message: string): string =>
  `usage: ${provider}: ${sanitizeUsageText(message)}`;

export const formatRefreshFailed = (
  provider: SupportedProvider,
  message: string,
  fetchedAt: number,
  nowMs: number = Date.now(),
): string =>
  `usage: ${provider}: refresh failed (${sanitizeUsageText(message)}); showing cached data from ${formatAge(fetchedAt, nowMs)}`;
