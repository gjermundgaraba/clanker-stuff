import { card } from "@clanker-stuff/pi-tool-rendering/card";
import { displayText, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { contentText } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  EntryRenderer,
  MessageRenderer,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

import { undeliveredSchema } from "./entries.js";
import { letterSchema } from "./mailbox.js";
import { peerListSchema, shortPath } from "./report.js";

const BODY_ROWS = 6;

const heading = (theme: Theme, mark: string, verb: string, name: string) =>
  `${mark} ${theme.fg("muted", verb)} ${theme.bold(inlineText(name))}`;

export const receivedMessage: MessageRenderer = (message, view, theme) => {
  if (!Value.Check(letterSchema, message.details)) {
    return undefined;
  }

  const { from, id, text } = message.details;

  return card(
    theme,
    view,
    {
      heading: heading(theme, theme.fg("accent", "✉"), "message from", from),
      aside: id,
      body: text,
    },
    { pad: view.outputPad, limit: BODY_ROWS }
  );
};

export const sentCard =
  (pad: () => number): EntryRenderer =>
  (entry, view, theme) => {
    if (!Value.Check(letterSchema, entry.data)) {
      return undefined;
    }

    const { to, id, text } = entry.data;

    return card(
      theme,
      view,
      {
        heading: heading(theme, theme.fg("accent", "↗"), "message to", to),
        aside: id,
        body: text,
      },
      { pad: pad(), limit: BODY_ROWS }
    );
  };

export const undeliveredCard =
  (pad: () => number): EntryRenderer =>
  (entry, view, theme) => {
    if (!Value.Check(undeliveredSchema, entry.data)) {
      return undefined;
    }

    const { to, text, reason, live } = entry.data;

    return card(
      theme,
      view,
      {
        heading: heading(theme, theme.fg("error", "✗"), "not delivered to", to),
        lines: [
          theme.fg(
            "dim",
            [
              reason,
              live.length ? `live: ${live.join(", ")}` : "no other live peers",
            ]
              .map(inlineText)
              .join(" · ")
          ),
        ],
        body: text,
      },
      { pad: pad(), limit: 2 }
    );
  };

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

const fallback = (
  theme: Theme,
  result: AgentToolResult<unknown>,
  isError: boolean
): Text =>
  new Text(
    theme.fg(
      isError ? "error" : "toolOutput",
      displayText(contentText(result.content))
    ),
    0,
    0
  );

export const sendResult = (
  theme: Theme,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  isError: boolean
): Text =>
  isError || options.isPartial || !Value.Check(letterSchema, result.details)
    ? fallback(theme, result, isError)
    : new Text(
        `${theme.fg("success", "✓ delivered")} ${theme.fg("dim", result.details.id)}`,
        0,
        0
      );

export const listResult = (
  theme: Theme,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  isError: boolean
): Text => {
  if (
    isError ||
    options.isPartial ||
    !Value.Check(peerListSchema, result.details)
  ) {
    return fallback(theme, result, isError);
  }

  const { peers, self } = result.details;

  return new Text(
    peers.length
      ? peers
          .map((peer) =>
            [
              `${theme.fg("accent", "●")} ${theme.bold(inlineText(peer.name))}${peer.sessionId === self ? theme.fg("muted", " (this session)") : ""}`,
              theme.fg("muted", inlineText(shortPath(peer.cwd))),
              theme.fg("dim", `pid ${peer.pid}`),
            ].join(theme.fg("dim", " · "))
          )
          .join("\n")
      : theme.fg("muted", "No live session has a peer name."),
    0,
    0
  );
};
