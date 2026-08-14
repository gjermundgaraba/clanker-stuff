/* oxlint-disable eslint/no-nested-ternary -- snapshot content keeps its fallback states adjacent */

import type {
  FooterWidgetHealthState,
  FooterWidgetSnapshot,
} from "@clanker-stuff/footer-protocol";

import { formatResetDuration } from "./format.js";
import { providerDisplayName } from "./providers.js";
import type { UsageSnapshot, UsageWindow } from "./providers.js";

const ACTIVE_WIDGET_ID = "clanker.usage.active";
const DETAILS_WIDGET_ID = "clanker.usage.details";

export const STATUS_KEY = "usage";

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

const selectActiveWindow = (
  snapshot: UsageSnapshot
): UsageWindow | undefined => {
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
    ? richText(
        `${providerDisplayName(snapshot.provider)} (${snapshot.planLabel})`,
        160
      )
    : providerDisplayName(snapshot.provider);

const health = (
  state: FooterWidgetHealthState,
  now: number,
  message?: string
): FooterWidgetSnapshot["health"] => ({
  ...(message !== undefined && message.length > 0
    ? { message: richText(message, 512) }
    : {}),
  state,
  updatedAt: now,
});

export const activeSnapshot = (
  snapshot: UsageSnapshot | undefined,
  state: FooterWidgetHealthState,
  now: number,
  message?: string
): FooterWidgetSnapshot => {
  const window = snapshot ? selectActiveWindow(snapshot) : undefined;
  const percent = window ? usedPercent(window) : 0;
  const rounded = `${Math.round(percent)}%`;
  const reset =
    window?.resetsAt === undefined
      ? ""
      : ` · ${formatResetDuration(window.resetsAt, now)}`;
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
  snapshot: UsageSnapshot | undefined,
  state: FooterWidgetHealthState,
  now: number,
  message?: string
): FooterWidgetSnapshot => {
  const active = snapshot ? selectActiveWindow(snapshot) : undefined;
  // ponytail: eight rich detail windows stay within protocol text bounds; /usage still shows all.
  const windows =
    snapshot?.windows.filter((window) => window !== active).slice(0, 8) ?? [];
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

export const fallbackText = (
  snapshot: UsageSnapshot | undefined,
  state: FooterWidgetHealthState
): string => {
  const window = snapshot ? selectActiveWindow(snapshot) : undefined;
  if (snapshot && window) {
    const marker = state === "stale" || state === "error" ? " !" : "";
    return richText(
      `usage ${providerDisplayName(snapshot.provider)} ${window.label} ${Math.round(usedPercent(window))}%${marker}`,
      240
    );
  }
  return state === "loading" ? "usage loading" : "usage unavailable";
};
