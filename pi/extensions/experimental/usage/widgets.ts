import {
  MAX_FOOTER_CONTENT_SPANS,
  type FooterContent,
  type FooterSpan,
  type FooterWidgetHealthState,
  type FooterWidgetSnapshot,
} from "@clanker-stuff/footer-protocol";
import { percentTone } from "@clanker-stuff/pi-tones";

import { formatCredits, formatResetDuration, formatUsd } from "./format.js";
import { providerDisplayName } from "./providers.js";
import type {
  SupportedProvider,
  UsageAccounting,
  UsageSnapshot,
  UsageWindow,
} from "./providers.js";

const ACTIVE_WIDGET_ID = "clanker.usage.active";

const DETAILS_WIDGET_ID = "clanker.usage.details";

export const STATUS_KEY = "usage";

export type UsagePresentation =
  | { kind: "unsupported" }
  | { kind: "loading"; provider: SupportedProvider }
  | { kind: "ready"; snapshot: UsageSnapshot }
  | { kind: "stale"; message: string; snapshot: UsageSnapshot }
  | { kind: "error"; message: string; provider: SupportedProvider };

const richText = (value: string, maximum: number): string => {
  let result = "";
  let length = 0;

  for (const char of value) {
    if (length >= maximum) break;
    const code = char.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
    length += 1;
  }

  return result;
};

const usedPercent = (window: UsageWindow): number =>
  Math.min(100, Math.max(0, 100 - window.remainingPercent));

const selectQuotaWindow = (snapshot: UsageSnapshot): UsageWindow | undefined => {
  let selected: UsageWindow | undefined;

  for (const window of snapshot.quotaWindows) {
    if (selected === undefined || usedPercent(window) > usedPercent(selected)) selected = window;
  }

  return selected;
};

const providerLabel = (snapshot: UsageSnapshot): string =>
  snapshot.planLabel !== undefined && snapshot.planLabel.length > 0
    ? richText(`${providerDisplayName(snapshot.provider)} (${snapshot.planLabel})`, 160)
    : providerDisplayName(snapshot.provider);

const health = (
  state: FooterWidgetHealthState,
  now: number,
  message?: string,
): NonNullable<FooterWidgetSnapshot["health"]> => ({
  ...(message !== undefined && message.length > 0 ? { message: richText(message, 512) } : {}),
  state,
  updatedAt: now,
});

const snapshotFor = (presentation: UsagePresentation): UsageSnapshot | undefined =>
  presentation.kind === "ready" || presentation.kind === "stale"
    ? presentation.snapshot
    : undefined;

const unreachablePresentation = (presentation: never): never => {
  throw new Error(`unknown usage presentation: ${String(presentation)}`);
};

const HEALTH_STATE_BY_PRESENTATION = {
  error: "error",
  loading: "loading",
  ready: "ready",
  stale: "stale",
  unsupported: "error",
} satisfies Record<UsagePresentation["kind"], FooterWidgetHealthState>;

const healthFor = (
  presentation: UsagePresentation,
): { message?: string; state: FooterWidgetHealthState } => {
  const state = HEALTH_STATE_BY_PRESENTATION[presentation.kind];

  return presentation.kind === "error" || presentation.kind === "stale"
    ? { message: presentation.message, state }
    : { state };
};

export const presentationProvider = (
  presentation: UsagePresentation,
): SupportedProvider | undefined => {
  switch (presentation.kind) {
    case "loading":
    case "error":
      return presentation.provider;
    case "ready":
    case "stale":
      return presentation.snapshot.provider;
    case "unsupported":
      return undefined;
    default:
      return unreachablePresentation(presentation);
  }
};

const accountingText = (accounting: UsageAccounting): string =>
  accounting.kind === "credit-balance"
    ? `${formatCredits(accounting.available)} credits`
    : `${formatUsd(accounting.available)} available`;

const accountingMetric = (accounting: UsageAccounting): FooterSpan => ({
  text: accountingText(accounting),
  tone: accounting.kind === "radius-billing" && accounting.available <= 0 ? "warning" : "text",
});

const unavailableWarning = (snapshot: UsageSnapshot): FooterSpan[] =>
  snapshot.ordinaryUsageAllowed === false
    ? [{ text: " · ordinary usage unavailable", tone: "warning" }]
    : [];

const activeContent = (snapshot: UsageSnapshot, now: number): FooterContent => {
  const window = selectQuotaWindow(snapshot);

  if (window !== undefined) {
    const percent = usedPercent(window);
    const filled = Math.round((percent / 100) * 10);

    const reset =
      window.resetsAt === undefined ? "" : ` · ${formatResetDuration(window.resetsAt, now)}`;

    return [
      { text: `${providerLabel(snapshot)} ${richText(window.label, 80)} `, tone: "muted" },
      { text: "━".repeat(filled), tone: percentTone(percent) },
      { text: "─".repeat(10 - filled), tone: "dim" },
      { text: ` ${Math.round(percent)}%${reset}`, tone: percentTone(percent) },
      ...unavailableWarning(snapshot),
    ];
  }

  if (snapshot.accounting !== undefined) {
    return [
      { text: `${providerLabel(snapshot)} `, tone: "muted" },
      accountingMetric(snapshot.accounting),
      ...unavailableWarning(snapshot),
    ];
  }

  if (snapshot.ordinaryUsageAllowed !== undefined) {
    return [
      {
        text: `${providerLabel(snapshot)} ordinary usage ${snapshot.ordinaryUsageAllowed ? "allowed" : "unavailable"}`,
        tone: snapshot.ordinaryUsageAllowed ? "text" : "warning",
      },
    ];
  }

  return [];
};

const accountingDetails = (accounting: UsageAccounting): FooterSpan[] =>
  accounting.kind === "credit-balance"
    ? []
    : [
        { text: `${formatUsd(accounting.balance)} balance`, tone: "muted" },
        { text: `${formatUsd(accounting.reserved)} reserved`, tone: "muted" },
        { text: `${formatUsd(accounting.currentMonthSpend)} month spend`, tone: "muted" },
      ];

const withSeparators = (segments: FooterSpan[]): FooterContent =>
  segments.slice(0, MAX_FOOTER_CONTENT_SPANS).map((segment, index) => ({
    ...segment,
    text: `${index === 0 ? "" : " · "}${segment.text}`,
  }));

const detailsContent = (snapshot: UsageSnapshot, now: number): FooterContent => {
  const selected = selectQuotaWindow(snapshot);
  const segments: FooterSpan[] = [];

  for (const window of snapshot.quotaWindows) {
    if (window === selected) continue;

    const reset =
      window.resetsAt === undefined ? "" : ` ${formatResetDuration(window.resetsAt, now)}`;

    const percent = usedPercent(window);
    segments.push({
      text: `${richText(window.label, 80)} ${Math.round(percent)}%${reset}`,
      tone: percentTone(percent),
    });
  }

  if (snapshot.accounting !== undefined) {
    if (selected !== undefined) segments.push(accountingMetric(snapshot.accounting));
    segments.push(...accountingDetails(snapshot.accounting));
  }

  return withSeparators(segments);
};

const fallbackContent = (snapshot: UsageSnapshot): string => {
  const label = providerDisplayName(snapshot.provider);
  const window = selectQuotaWindow(snapshot);
  let metric: string;

  if (window !== undefined) {
    metric = `${window.label} ${Math.round(usedPercent(window))}%`;
  } else if (snapshot.accounting !== undefined) {
    metric = accountingText(snapshot.accounting);
  } else if (snapshot.ordinaryUsageAllowed !== undefined) {
    metric = `ordinary usage ${snapshot.ordinaryUsageAllowed ? "allowed" : "unavailable"}`;
  } else {
    return "usage unavailable";
  }

  const warning =
    snapshot.ordinaryUsageAllowed === false &&
    (window !== undefined || snapshot.accounting !== undefined)
      ? " ordinary unavailable"
      : "";

  return richText(`usage ${label} ${metric}${warning}`, 240);
};

export const activeSnapshot = (
  presentation: UsagePresentation,
  now: number,
): FooterWidgetSnapshot => {
  const snapshot = snapshotFor(presentation);
  const { message, state } = healthFor(presentation);

  return {
    consumesStatusKeys: [STATUS_KEY],
    content:
      snapshot === undefined
        ? state === "loading"
          ? [{ text: "loading usage", tone: "dim" }]
          : []
        : activeContent(snapshot, now),
    defaults: { enabled: true },
    health: health(state, now, message),
    icon: {
      glyphs: { ascii: "usage", nerd: "󰓅", unicode: "◴" },
      tone: "dim",
    },
    id: ACTIVE_WIDGET_ID,
    label: "Active provider usage",
    truncate: "middle",
  };
};

export const detailsSnapshot = (
  presentation: UsagePresentation,
  now: number,
): FooterWidgetSnapshot => {
  const snapshot = snapshotFor(presentation);
  const { message, state } = healthFor(presentation);

  return {
    consumesStatusKeys: [STATUS_KEY],
    content: snapshot === undefined ? [] : detailsContent(snapshot, now),
    defaults: { enabled: false },
    health: health(state, now, message),
    id: DETAILS_WIDGET_ID,
    label: "Provider usage details",
  };
};

export const fallbackText = (presentation: UsagePresentation): string => {
  const snapshot = snapshotFor(presentation);

  if (snapshot === undefined) {
    return presentation.kind === "loading" ? "usage loading" : "usage unavailable";
  }

  return `${fallbackContent(snapshot)}${presentation.kind === "stale" ? " !" : ""}`;
};
