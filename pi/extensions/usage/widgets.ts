import type { FooterWidgetHealthState, FooterWidgetSnapshot } from "@clanker-stuff/footer-protocol";

import { formatResetDuration } from "./format.js";
import { providerDisplayName } from "./providers.js";
import type { SupportedProvider, UsageSnapshot, UsageWindow } from "./providers.js";

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
    if (length >= maximum) {
      break;
    }
    const code = char.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
    length += 1;
  }
  return result;
};

const usedPercent = (window: UsageWindow): number =>
  Math.min(100, Math.max(0, 100 - window.remainingPercent));

const toneFor = (percent: number): "error" | "text" | "warning" => {
  if (percent >= 90) {
    return "error";
  }
  return percent >= 70 ? "warning" : "text";
};

const selectActiveWindow = (snapshot: UsageSnapshot): UsageWindow | undefined => {
  let selected: UsageWindow | undefined;
  for (const window of snapshot.windows) {
    if (selected === undefined || usedPercent(window) > usedPercent(selected)) {
      selected = window;
    }
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
): FooterWidgetSnapshot["health"] => {
  const health: FooterWidgetSnapshot["health"] = { state, updatedAt: now };
  if (message !== undefined && message.length > 0) {
    health.message = richText(message, 512);
  }
  return health;
};

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
    case "error": {
      return presentation.provider;
    }
    case "ready":
    case "stale": {
      return presentation.snapshot.provider;
    }
    case "unsupported": {
      return undefined;
    }
    default: {
      return unreachablePresentation(presentation);
    }
  }
};

export const activeSnapshot = (
  presentation: UsagePresentation,
  now: number,
): FooterWidgetSnapshot => {
  const snapshot = snapshotFor(presentation);
  const { message, state } = healthFor(presentation);
  const window = snapshot ? selectActiveWindow(snapshot) : undefined;
  const percent = window ? usedPercent(window) : 0;
  const rounded = `${Math.round(percent)}%`;
  const reset =
    window?.resetsAt === undefined ? "" : ` · ${formatResetDuration(window.resetsAt, now)}`;
  const filled = Math.round((percent / 100) * 10);
  const full =
    snapshot && window
      ? [
          {
            text: `${providerLabel(snapshot)} ${richText(window.label, 80)} `,
            tone: "accent" as const,
          },
          { text: "━".repeat(filled), tone: toneFor(percent) },
          { text: "─".repeat(10 - filled), tone: "dim" as const },
          { text: ` ${rounded}${reset}`, tone: toneFor(percent) },
        ]
      : state === "loading"
        ? [{ text: "loading usage", tone: "dim" as const }]
        : [];
  return {
    consumesStatusKeys: [STATUS_KEY],
    content: full,
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
  const active = snapshot ? selectActiveWindow(snapshot) : undefined;
  // ponytail: eight rich detail windows stay within protocol text bounds; /usage still shows all.
  const windows = snapshot?.windows.filter((window) => window !== active).slice(0, 8) ?? [];
  const full = windows.map((window, index) => ({
    text: `${index === 0 ? "" : " · "}${richText(window.label, 80)} ${Math.round(usedPercent(window))}%${
      window.resetsAt !== undefined && window.resetsAt.length > 0
        ? ` ${formatResetDuration(window.resetsAt, now)}`
        : ""
    }`,
    tone: toneFor(usedPercent(window)),
  }));
  return {
    consumesStatusKeys: [STATUS_KEY],
    content: full,
    defaults: { enabled: false },
    health: health(state, now, message),
    id: DETAILS_WIDGET_ID,
    label: "Provider usage details",
  };
};

export const fallbackText = (presentation: UsagePresentation): string => {
  const snapshot = snapshotFor(presentation);
  const window = snapshot ? selectActiveWindow(snapshot) : undefined;
  if (snapshot && window) {
    const marker = presentation.kind === "stale" ? " !" : "";
    return richText(
      `usage ${providerDisplayName(snapshot.provider)} ${window.label} ${Math.round(usedPercent(window))}%${marker}`,
      240,
    );
  }
  return presentation.kind === "loading" ? "usage loading" : "usage unavailable";
};
