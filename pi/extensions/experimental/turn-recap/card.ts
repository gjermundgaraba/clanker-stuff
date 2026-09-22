import {
  BREATHING_DOT_FRAMES,
  BREATHING_DOT_INTERVAL_MS,
  STATIC_BREATHING_DOT_FRAME,
} from "@clanker-stuff/pi-motion";
import { percentTone } from "@clanker-stuff/pi-tones";
import type { Tone } from "@clanker-stuff/pi-tones";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { sanitizeRecapText } from "./conversation.js";
import type { Snapshot } from "./entry.js";
import { totalTokens } from "./metrics.js";
import { formatElapsed } from "./timing.js";

export interface CardState {
  snapshot: Snapshot | undefined;
  previousRecap: string | undefined;
  running: boolean;
  waiting: boolean;
  expanded: boolean;
}

const number = (value: number): string =>
  value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;

const clock = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const renderCard = (
  state: CardState,
  width: number,
  theme: Theme,
  terminalRows: number,
): string[] => {
  const maxRows = Math.min(state.expanded ? 12 : 5, Math.floor(terminalRows / 2));

  if (width <= 0 || maxRows <= 0) return [];
  const { snapshot, running, waiting, expanded } = state;

  if (!snapshot)
    return [
      truncateToWidth(
        theme.fg("dim", "Turn recap · No turns yet · /turn-recap for details"),
        width,
      ),
    ];

  const { metrics, recap } = snapshot;

  const status = running
    ? waiting
      ? "Waiting for you"
      : "Running"
    : snapshot.outcome === "error"
      ? "Failed"
      : snapshot.outcome === "aborted"
        ? "Aborted"
        : "Completed";

  const tone: Extract<Tone, "accent" | "warning" | "muted" | "error"> = running
    ? waiting
      ? "warning"
      : "accent"
    : snapshot.outcome === "error"
      ? "error"
      : "muted";

  const frame =
    running && !waiting
      ? (BREATHING_DOT_FRAMES[
          Math.floor(snapshot.activeMs / BREATHING_DOT_INTERVAL_MS) % BREATHING_DOT_FRAMES.length
        ] ?? STATIC_BREATHING_DOT_FRAME)
      : STATIC_BREATHING_DOT_FRAME;

  const heading =
    theme.fg("borderMuted", "─ Turn recap · ") +
    theme.fg(tone, `${frame.marker} ${status} `) +
    theme.fg("borderMuted", "─".repeat(width));

  const lines = [truncateToWidth(heading, width, "")];
  const indent = width > 2 ? "  " : "";

  const add = (text: string) => {
    if (lines.length > maxRows) return;
    lines.push(
      ...wrapTextWithAnsi(text, Math.max(1, width - indent.length))
        .slice(0, maxRows + 1 - lines.length)
        .map((line) => truncateToWidth(`${indent}${line}`, width, "")),
    );
  };

  const finish = () => {
    if (lines.length <= maxRows) return lines;
    const last = lines[maxRows - 1] ?? "";

    return [
      ...lines.slice(0, maxRows - 1),
      truncateToWidth(last, Math.max(0, width - 1), "") + theme.fg("dim", "…"),
    ];
  };

  const usage = metrics.usage;
  const tokens = `${number(totalTokens(usage))} tokens${running ? " reported" : ""}`;
  lines.push(
    truncateToWidth(
      theme.fg(
        "muted",
        `${indent}${formatElapsed(snapshot.activeMs)} active · ${clock(running ? snapshot.startedAt : snapshot.finishedAt)} · ${metrics.toolCalls} tools · ${tokens}`,
      ),
      width,
      "…",
    ),
  );

  if (!running && recap.status === "ready") {
    add(theme.fg("text", sanitizeRecapText(recap.text)));
  } else {
    // Current status takes priority over stale text within the row budget.
    if (!running && recap.status === "pending") add(theme.fg("dim", "Generating recap…"));

    if (!running && recap.status === "failed")
      add(
        theme.fg(
          "muted",
          expanded
            ? `Recap unavailable: ${sanitizeRecapText(recap.error)}`
            : "Recap unavailable · /turn-recap for details",
        ),
      );

    if (!running && recap.status === "cancelled") add(theme.fg("dim", "Recap interrupted"));

    if (state.previousRecap)
      add(theme.fg("muted", `Previous recap: ${sanitizeRecapText(state.previousRecap)}`));
  }

  if (!expanded) return finish();

  add(
    theme.fg(
      "muted",
      `Input ${number(usage.input)} · Output ${number(usage.output)} · Cache read ${number(usage.cacheRead)} · Cache write ${number(usage.cacheWrite)}`,
    ),
  );

  const reasoning =
    usage.reasoningReports === 0
      ? "not reported"
      : `${number(usage.reasoning)}${usage.reasoningReports < usage.reports ? " (partially reported)" : ""} (included in output)`;

  add(theme.fg("muted", `Reasoning ${reasoning} · Reported cost $${usage.cost.toFixed(4)}`));
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
  const context = metrics.context;

  if (context) {
    const percent = context.percent;
    add(
      theme.fg(
        percent === null ? "muted" : percentTone(percent),
        `Context ≈ ${context.tokens === null ? "unknown" : number(context.tokens)} / ${number(context.contextWindow)}${percent === null ? "" : ` (${percent.toFixed(1)}%)`}`,
      ),
    );
  }

  if ((recap.status === "ready" || recap.status === "failed") && recap.usage) {
    add(
      theme.fg(
        "dim",
        `Recap only: ${number(totalTokens(recap.usage))} tokens · $${recap.usage.cost.toFixed(4)} reported (excluded above)`,
      ),
    );
  }

  return finish();
};
