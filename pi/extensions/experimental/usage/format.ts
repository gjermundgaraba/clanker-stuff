import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

import { providerDisplayName } from "./providers.js";
import type { SupportedProvider, UsageAccounting, UsageSnapshot } from "./providers.js";

const USD_FORMAT = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
});

const CREDIT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Reset times are normalized ISO strings from the adapters. */
export const formatResetDuration = (resetsAt: string, nowMs: number): string => {
  const remainingMs = Date.parse(resetsAt) - nowMs;

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

const formatAge = (fetchedAt: number, nowMs: number): string => {
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

export const formatProviderLabel = (snapshot: UsageSnapshot): string =>
  snapshot.planLabel === undefined
    ? providerDisplayName(snapshot.provider)
    : `${providerDisplayName(snapshot.provider)} (${inlineText(snapshot.planLabel)})`;

export const formatDetail = (snapshot: UsageSnapshot, nowMs: number): string => {
  const lines = [formatProviderLabel(snapshot)];

  const windows = [...snapshot.quotaWindows, ...(snapshot.additionalQuotaWindows ?? [])];

  for (const window of windows) {
    const reset =
      window.resetsAt === undefined
        ? "resets unknown"
        : `resets in ${formatResetDuration(window.resetsAt, nowMs)}`;

    lines.push(
      `${inlineText(window.label)}  ${Math.round(window.remainingPercent)}% left  ${reset}`,
    );
  }

  if (snapshot.accounting !== undefined) {
    lines.push(...accountingLines(snapshot.accounting, nowMs));
  }

  return lines.join("\n");
};

export const formatProviderError = (provider: SupportedProvider, message: string): string =>
  `usage: ${provider}: ${inlineText(message)}`;

export const formatRefreshFailed = (
  provider: SupportedProvider,
  message: string,
  fetchedAt: number,
  nowMs: number,
): string =>
  `usage: ${provider}: refresh failed (${inlineText(message)}); showing cached data from ${formatAge(fetchedAt, nowMs)}`;
