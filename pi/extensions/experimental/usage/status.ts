import { percentTone } from "@clanker-stuff/pi-tones";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatCredits, formatResetDuration, formatUsd } from "./format.js";
import { providerDisplayName } from "./providers.js";
import type { SupportedProvider, UsageSnapshot, UsageWindow } from "./providers.js";

export const STATUS_KEY = "usage";

export type UsagePresentation =
  | { kind: "loading"; provider: SupportedProvider }
  | { kind: "ready"; snapshot: UsageSnapshot }
  | { kind: "stale"; snapshot: UsageSnapshot }
  | { kind: "error"; provider: SupportedProvider };

export const presentationProvider = (presentation: UsagePresentation): SupportedProvider =>
  presentation.kind === "ready" || presentation.kind === "stale"
    ? presentation.snapshot.provider
    : presentation.provider;

const METER_CELLS = 10;

const usedPercent = (window: UsageWindow): number =>
  Math.min(100, Math.max(0, 100 - window.remainingPercent));

/** The window closest to its limit is the one that will stop work first. */
const selectQuotaWindow = (snapshot: UsageSnapshot): UsageWindow | undefined => {
  let selected: UsageWindow | undefined;

  for (const window of snapshot.quotaWindows) {
    if (selected === undefined || usedPercent(window) > usedPercent(selected)) selected = window;
  }

  return selected;
};

const providerLabel = (snapshot: UsageSnapshot): string =>
  snapshot.planLabel !== undefined && snapshot.planLabel.length > 0
    ? `${providerDisplayName(snapshot.provider)} (${inlineText(snapshot.planLabel)})`
    : providerDisplayName(snapshot.provider);

const metricText = (snapshot: UsageSnapshot, now: number, theme: Pick<Theme, "fg">): string => {
  const window = selectQuotaWindow(snapshot);

  if (window !== undefined) {
    const percent = usedPercent(window);
    const tone = percentTone(percent);
    const filled = Math.round((percent / 100) * METER_CELLS);

    return [
      theme.fg("muted", `${window.label} `),
      theme.fg(tone, "━".repeat(filled)),
      theme.fg("dim", "─".repeat(METER_CELLS - filled)),
      theme.fg(tone, ` ${Math.round(percent)}%`),
      window.resetsAt === undefined
        ? ""
        : theme.fg("muted", ` · ${formatResetDuration(window.resetsAt, now)}`),
    ].join("");
  }

  const { accounting } = snapshot;

  if (accounting === undefined) return "";

  return accounting.kind === "credit-balance"
    ? theme.fg("text", `${formatCredits(accounting.available)} credits`)
    : theme.fg(
        accounting.available <= 0 ? "warning" : "text",
        `${formatUsd(accounting.available)} available`,
      );
};

/** The native `usage` status line: quiet unless a quota is filling or data is stale. */
export const statusText = (
  presentation: UsagePresentation,
  now: number,
  theme: Pick<Theme, "fg">,
): string => {
  switch (presentation.kind) {
    case "loading":
      return theme.fg("dim", `${providerDisplayName(presentation.provider)} usage loading`);
    case "error":
      return theme.fg("muted", `${providerDisplayName(presentation.provider)} usage unavailable`);
    case "ready":
    case "stale":
      return [
        theme.fg("muted", `${providerLabel(presentation.snapshot)} `),
        metricText(presentation.snapshot, now, theme),
        presentation.kind === "stale" ? theme.fg("warning", " !") : "",
      ].join("");
  }
};
