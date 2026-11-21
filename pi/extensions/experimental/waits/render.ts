import { card } from "@clanker-stuff/pi-tool-rendering/card";
import type { CardView } from "@clanker-stuff/pi-tool-rendering/card";
import { displayText, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { contentText } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  EntryRenderer,
  MessageRenderer,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

import { endedSchema, openedSchema } from "./journal.js";
import { toolDetailsSchema, wakeDetailsSchema } from "./report.js";
import type { WaitRow, WakeDetails } from "./report.js";

/** A duration as its two largest units: 9s, 57m, 3h 2m, 2d 4h. */
export const span = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);

  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
};

/** A local wall-clock time, with the date when it is not today. */
export const clock = (at: number, now = Date.now()): string => {
  const date = new Date(at);

  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
};

const MARKS: Record<WaitRow["state"], (theme: Theme) => string> = {
  open: (theme) => theme.fg("accent", "●"),
  satisfied: (theme) => theme.fg("success", "✓"),
  expired: (theme) => theme.fg("error", "✗"),
  cancelled: (theme) => theme.fg("muted", "■"),
};

const heading = (
  theme: Theme,
  mark: string,
  verb: string,
  label: string
): string =>
  `${mark} ${theme.fg("muted", verb)} ${theme.bold(inlineText(label))}`;

export const openedCard =
  (pad: () => number): EntryRenderer =>
  (entry, view, theme) => {
    if (!Value.Check(openedSchema, entry.data)) {
      return undefined;
    }

    const { id, spec, expiresAt } = entry.data;

    return card(
      theme,
      view,
      {
        heading: heading(theme, "⏳", "waiting on", spec.label),
        aside: id,
        lines: [
          theme.fg("toolOutput", inlineText(spec.condition)),
          theme.fg(
            "dim",
            `every ${span(spec.intervalSeconds * 1000)} · expires ${clock(expiresAt)}`
          ),
        ],
        ...(view.expanded ? { body: spec.instruction } : {}),
      },
      { pad: pad() }
    );
  };

/**
 * Draws a cancellation. A satisfied or expired wait draws nothing here,
 * because the wake that follows it carries the outcome.
 */
export const endedCard =
  (
    labelOf: (id: string) => string | undefined,
    pad: () => number
  ): EntryRenderer =>
  (entry, view, theme) => {
    if (
      !Value.Check(endedSchema, entry.data) ||
      entry.data.outcome !== "cancelled"
    ) {
      return undefined;
    }

    const { id } = entry.data;

    return card(
      theme,
      view,
      {
        heading: heading(
          theme,
          MARKS.cancelled(theme),
          "wait cancelled",
          labelOf(id) ?? id
        ),
        aside: id,
      },
      { pad: pad() }
    );
  };

const wakeCard = (
  theme: Theme,
  view: CardView,
  wait: WakeDetails["waits"][number],
  pad: number
): Component =>
  card(
    theme,
    view,
    {
      heading: heading(
        theme,
        MARKS[wait.outcome](theme),
        `wait ${wait.outcome}`,
        wait.label
      ),
      aside: wait.id,
      lines: [
        theme.fg(
          "dim",
          wait.outcome === "satisfied"
            ? "condition exited 0 · woke the agent"
            : `never exited 0 · ${wait.lastCheck}`
        ),
      ],
      body: wait.instruction,
    },
    { pad }
  );

export const wakeMessage: MessageRenderer = (message, view, theme) => {
  if (!Value.Check(wakeDetailsSchema, message.details)) {
    return undefined;
  }

  const container = new Container();

  for (const [index, wait] of message.details.waits.entries()) {
    if (index > 0) {
      container.addChild(new Spacer(1));
    }

    container.addChild(wakeCard(theme, view, wait, view.outputPad));
  }

  return container;
};

export const rowLine = (theme: Theme, row: WaitRow): string =>
  [
    `${MARKS[row.state](theme)} ${theme.bold(inlineText(row.label))}`,
    theme.fg("muted", row.state === "open" ? row.lastCheck : row.state),
    theme.fg("dim", row.id),
  ].join(theme.fg("dim", " · "));

export const callLine = (
  theme: Theme,
  name: string,
  target: string | undefined
): Text =>
  new Text(
    `${theme.fg("toolTitle", theme.bold(name))}${target === undefined || target === "" ? "" : ` ${theme.fg("accent", inlineText(target))}`}`,
    0,
    0
  );

export const rowsResult = (
  theme: Theme,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  isError: boolean
): Text => {
  const text = contentText(result.content);

  if (
    isError ||
    options.isPartial ||
    !Value.Check(toolDetailsSchema, result.details)
  ) {
    return new Text(
      theme.fg(isError ? "error" : "toolOutput", displayText(text)),
      0,
      0
    );
  }

  const { rows } = result.details;

  return new Text(
    rows.length
      ? rows.map((row) => rowLine(theme, row)).join("\n")
      : theme.fg("muted", "No live waits in this session."),
    0,
    0
  );
};
