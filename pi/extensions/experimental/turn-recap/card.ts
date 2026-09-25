import { percentTone } from "@clanker-stuff/pi-tones";
import type { Tone } from "@clanker-stuff/pi-tones";
import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

import { sanitizeRecapText } from "./conversation.js";
import { SnapshotSchema } from "./entry.js";
import type { Recap, Snapshot } from "./entry.js";
import { totalTokens } from "./metrics.js";
import type { Metrics } from "./metrics.js";
import { formatElapsed } from "./timing.js";

type Foreground = Pick<Theme, "fg">;

/** Supplies the displayed text for one numeric field before styling and layout. */
export type NumericText = (id: string, text: string) => string;

const plain: NumericText = (_id, text) => text;

const number = (value: number): string =>
  value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;

const signed = (value: number): string => `${value < 0 ? "−" : "+"}${number(Math.abs(value))}`;

const clock = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// Values carry the contrast so labels and separators can recede.
const stat = (theme: Foreground, value: string, label: string, tone: Tone = "text") =>
  theme.fg(tone, value) + theme.fg("muted", ` ${label}`);

const row = (theme: Foreground, parts: string[]) => parts.join(theme.fg("dim", " · "));

const statistics = (
  metrics: Metrics,
  theme: Foreground,
  expanded: boolean,
  numeric: NumericText,
): string[] => {
  const { context } = metrics;
  const percent = context?.percent;

  // The counter shows growth during this run; details keep the whole window in view.
  const added =
    context === undefined
      ? "unavailable"
      : context.tokens === null || context.startTokens === null
        ? "unknown"
        : numeric("context", signed(context.tokens - context.startTokens));

  // Details only appear on finished cards, which never animate.
  const windowDetail =
    context &&
    (context.tokens === null
      ? `${number(context.contextWindow)} window`
      : `≈${number(context.tokens)}/${number(context.contextWindow)}${percent == null ? "" : `, ${percent.toFixed(1)}%`}`);

  const contextValue = expanded && windowDetail ? `${added} (${windowDetail})` : added;

  const contextTone: Tone =
    percent != null ? percentTone(percent) : context?.tokens == null ? "muted" : "text";

  return [
    stat(
      theme,
      numeric("tools", String(metrics.toolCalls)),
      metrics.toolCalls === 1 ? "tool" : "tools",
    ),
    stat(theme, numeric("processed", number(totalTokens(metrics.usage))), "processed"),
    expanded && context
      ? theme.fg("muted", "Context ") + theme.fg(contextTone, contextValue)
      : stat(theme, contextValue, "context", contextTone),
  ];
};

export interface LiveState {
  activeMs: number;
  /** A paused row freezes; it only stops the widget's timer. */
  paused: boolean;
  metrics: Metrics;
}

/** A card's recap as the runtime knows it; generation lives only in memory. */
export type RecapView = Recap | { status: "generating" };

/** One row above the editor while a run is active. */
export const renderLive = (
  state: LiveState,
  width: number,
  theme: Foreground,
  numeric: NumericText = plain,
): string[] => {
  if (width <= 0) return [];

  const text = row(theme, [
    stat(theme, numeric("active", formatElapsed(state.activeMs, "seconds")), "active"),
    ...statistics(state.metrics, theme, false, numeric),
  ]);

  return [truncateToWidth(`${width > 2 ? "  " : ""}${text}`, width, "…")];
};

/** The finished run as a transcript card; `expanded` follows Pi's tool-output toggle. */
export const renderCard = (
  snapshot: Snapshot,
  recap: RecapView | undefined,
  width: number,
  theme: Foreground,
  expanded: boolean,
): string[] => {
  if (width <= 0) return [];
  const { metrics } = snapshot;
  const usage = metrics.usage;
  const indent = width > 2 ? "  " : "";

  const outcome =
    snapshot.outcome === "error"
      ? "Failed after"
      : snapshot.outcome === "aborted"
        ? "Aborted after"
        : "Completed in";

  const outcomeTone = snapshot.outcome === "error" ? "error" : "muted";

  const lines = [
    truncateToWidth(
      theme.fg("borderMuted", "─ Turn recap · ") +
        theme.fg(
          outcomeTone,
          `${outcome} ${formatElapsed(snapshot.activeMs)} at ${clock(snapshot.finishedAt)} `,
        ) +
        theme.fg("borderMuted", "─".repeat(width)),
      width,
      "",
    ),
  ];

  const add = (text: string) => {
    for (const line of wrapTextWithAnsi(text, Math.max(1, width - indent.length)))
      lines.push(truncateToWidth(`${indent}${line}`, width, ""));
  };

  if (recap?.status === "ready") add(theme.fg("text", sanitizeRecapText(recap.text)));

  if (recap?.status === "failed") {
    const failure = theme.fg("muted", `Recap unavailable: ${sanitizeRecapText(recap.error)}`);

    if (expanded) add(failure);
    else lines.push(truncateToWidth(`${indent}${failure}`, width, "…"));
  }

  if (recap?.status === "generating") add(theme.fg("dim", "Generating recap…"));

  // Recap prose and statistics read as separate blocks.
  if (recap) lines.push("");
  add(row(theme, statistics(metrics, theme, expanded, plain)));

  if (!expanded) return lines;

  const reasoning =
    usage.reasoningReports === 0
      ? "not reported"
      : `${number(usage.reasoning)}${usage.reasoningReports < usage.reports ? " (partially reported)" : ""} (included in output)`;

  add(theme.fg("muted", `Reported cost $${usage.cost.toFixed(4)} · Reasoning ${reasoning}`));

  if (recap?.status !== "generating" && recap?.usage) {
    add(
      theme.fg(
        "dim",
        `Recap only: ${number(totalTokens(recap.usage))} tokens · $${recap.usage.cost.toFixed(4)} reported (excluded above)`,
      ),
    );
  }

  add(
    theme.fg(
      "muted",
      `Input ${number(usage.input)} · Output ${number(usage.output)} · Cache read ${number(usage.cacheRead)} · Cache write ${number(usage.cacheWrite)}`,
    ),
  );
  add(
    theme.fg(
      "muted",
      `${metrics.responses} responses · ${metrics.toolErrors} tool errors · ${metrics.compactions} compactions`,
    ),
  );
  add(
    theme.fg(
      "muted",
      `${formatElapsed(snapshot.wallMs)} wall · ${formatElapsed(Math.max(0, snapshot.wallMs - snapshot.activeMs))} waiting · Started ${clock(snapshot.startedAt)}`,
    ),
  );

  if (metrics.models.length > 0)
    add(theme.fg("muted", `Models: ${metrics.models.map(sanitizeRecapText).join(", ")}`));

  return lines;
};

/**
 * Draws saved cards in the transcript. Pi renders every card on every frame, so each keeps
 * its lines until the width or its recap changes; expanding or retheming rebuilds the card.
 * Entries from retired schemas no longer render.
 */
export const createCardRenderer =
  (recap: (runId: string) => RecapView | undefined): EntryRenderer =>
  (entry, { expanded }, theme) => {
    const snapshot = entry.data;

    if (!Value.Check(SnapshotSchema, snapshot)) return undefined;
    let cached: { width: number; recap: RecapView | undefined; lines: string[] } | undefined;

    return {
      render(width) {
        const current = recap(snapshot.runId);

        if (cached?.width !== width || cached.recap !== current)
          cached = {
            width,
            recap: current,
            lines: renderCard(snapshot, current, width, theme, expanded),
          };

        return cached.lines;
      },
      invalidate() {
        cached = undefined;
      },
    };
  };
