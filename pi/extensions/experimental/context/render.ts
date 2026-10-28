import { percentTone } from "@clanker-stuff/pi-tones";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ContextSnapshot, InspectorSnapshot } from "./snapshot.js";
import type { FlatRow } from "./tree.js";

const MIN_WIDTH = 5;

const MIN_HEIGHT = 10;

const LEGEND_MIN_HEIGHT = 14;

const ROOMY_MIN_HEIGHT = 20;

const CHROME_ROWS = 7;

export const PAD = "  ";

export const OVERLAY_HEIGHT_RATIO = 0.9;

const SPLIT_MIN_WIDTH = 80;

const ROW_BAR_WIDTH = 8;

const ROW_BAR_MIN_TREE_WIDTH = 40;

export const fit = (text: string, width: number): string =>
  truncateToWidth(text, width, "…", true);

const count = (value: number): string => value.toLocaleString("en-US");

export const estimate = (value: number): string => `~${count(value)}`;

export const overlayHeight = (terminalRows: number): number =>
  Math.max(1, Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO));

export const layoutOverlay = (
  width: number,
  height: number,
  detail: boolean
) => {
  const innerWidth = Math.max(0, width - 2);
  const split = width >= SPLIT_MIN_WIDTH && !detail;
  const treeWidth = split ? Math.floor(innerWidth * 0.42) : innerWidth;
  const showLegend = height >= LEGEND_MIN_HEIGHT;
  const roomy = height >= ROOMY_MIN_HEIGHT;

  const bodyHeight = Math.max(
    0,
    height - CHROME_ROWS - (showLegend ? 1 : 0) - (roomy ? 3 : 0)
  );

  return {
    width,
    innerWidth,
    treeWidth,
    previewWidth: split ? innerWidth - treeWidth - 1 : 0,
    showLegend,
    roomy,
    bodyTop: 4 + (showLegend ? 1 : 0) + (roomy ? 3 : 0),
    bodyHeight,
    previewHeaderRows: bodyHeight > 3 ? 2 : 1,
    tooSmall: width < MIN_WIDTH || height < MIN_HEIGHT,
  };
};

export type Layout = ReturnType<typeof layoutOverlay>;

const usedPercent = (usage: ContextUsage | undefined): number | undefined =>
  usage === undefined || usage.tokens === null || usage.contextWindow <= 0
    ? undefined
    : (usage.tokens / usage.contextWindow) * 100;

export const renderUsageBar = (
  theme: Theme,
  usage: ContextUsage | undefined,
  width: number
) => {
  if (width <= 0) {
    return "";
  }

  const percent = usedPercent(usage) ?? 0;

  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width))
  );

  return (
    theme.fg(percentTone(percent), "█".repeat(filled)) +
    theme.fg("scrollbarTrack", "░".repeat(width - filled))
  );
};

export const renderUsageLine = (
  theme: Theme,
  usage: ContextUsage | undefined
): string => {
  const percent = usedPercent(usage);

  if (usage === undefined || usage.tokens === null || percent === undefined) {
    return theme.fg("muted", "Pi context usage: unknown");
  }

  return [
    theme.bold(count(usage.tokens)),
    theme.fg("muted", ` / ${count(usage.contextWindow)} tokens`),
    theme.fg("dim", " · "),
    theme.fg(percentTone(percent), `${percent.toFixed(1)}% used`),
    theme.fg("dim", " · "),
    theme.fg(
      "muted",
      `${count(Math.max(0, usage.contextWindow - usage.tokens))} free`
    ),
  ].join("");
};

const sum = (parts: ReadonlyArray<{ estimatedTokens: number }>) =>
  parts.reduce((total, part) => total + part.estimatedTokens, 0);

export const renderLegend = (
  theme: Theme,
  snapshot: ContextSnapshot
): string => {
  const estimates = [
    ["system", snapshot.system.estimatedTokens],
    ["tools", sum(snapshot.tools)],
    ["messages", sum(snapshot.messages)],
  ] as const;

  const total = estimates.reduce(
    (subtotal, [, tokens]) => subtotal + tokens,
    0
  );

  return estimates
    .map(
      ([label, tokens]) =>
        label +
        theme.fg(
          "muted",
          ` ${estimate(tokens)}${total > 0 ? ` · ${Math.round((tokens / total) * 100)}%` : ""}`
        )
    )
    .join(theme.fg("dim", "   "));
};

const renderRowBar = (theme: Theme, share: number): string => {
  const filled = Math.max(share > 0 ? 1 : 0, Math.round(share * ROW_BAR_WIDTH));

  return (
    theme.fg("muted", "█".repeat(filled)) +
    theme.fg("scrollbarTrack", "░".repeat(ROW_BAR_WIDTH - filled))
  );
};

export const countColumnWidth = (rows: readonly FlatRow[]): number =>
  Math.max(6, ...rows.map((row) => estimate(row.node.estimatedTokens).length));

export const renderTreeRows = (
  theme: Theme,
  rows: readonly FlatRow[],
  selected: number,
  width: number,
  countWidth: number,
  showEstimates: boolean
): string[] => {
  const showBar = showEstimates && width >= ROW_BAR_MIN_TREE_WIDTH;

  const labelWidth = Math.max(
    1,
    width -
      2 -
      (showBar ? ROW_BAR_WIDTH + 1 : 0) -
      (showEstimates ? countWidth + 2 : 0)
  );

  return rows.map((row, index) => {
    const active = index === selected;
    const isGroup = row.node.children.length > 0;

    const branch =
      row.depth === 0
        ? ""
        : `${"  ".repeat(row.depth)}${row.last ? "└ " : "├ "}`;

    let glyph = "  ";

    if (row.depth === 0 && isGroup) {
      glyph = row.expanded ? "▾ " : "▸ ";
    }

    const name = theme.fg(
      row.node.tone === "code" ? "mdCode" : row.node.tone,
      displayText(row.node.label)
    );

    const label = [
      theme.fg("dim", branch),
      theme.fg("muted", glyph),
      row.depth === 0 ? theme.bold(name) : name,
      isGroup ? theme.fg("dim", ` (${row.node.children.length})`) : "",
    ].join("");

    const line = [
      " ",
      active ? theme.fg("accent", "▌") : " ",
      fit(label, labelWidth),
      " ",
      showBar ? `${renderRowBar(theme, row.share)} ` : "",
      showEstimates
        ? theme.fg(
            "muted",
            estimate(row.node.estimatedTokens).padStart(countWidth)
          )
        : "",
      " ",
    ].join("");

    return active ? theme.bg("selectedBg", line) : line;
  });
};

export const renderScrollbar = (
  theme: Theme,
  height: number,
  offset: number,
  total: number
): string[] => {
  if (height <= 0) {
    return [];
  }

  if (total <= height) {
    return Array.from({ length: height }, () => " ");
  }

  const thumb = Math.max(1, Math.round((height / total) * height));
  const start = Math.round((offset / (total - height)) * (height - thumb));

  return Array.from({ length: height }, (_, index) =>
    index >= start && index < start + thumb
      ? theme.fg("scrollbarThumb", "┃")
      : theme.fg("dim", "│")
  );
};

export interface FooterKey {
  readonly key: string;
  readonly label: string;
}

export const renderFooter = (
  theme: Theme,
  keys: readonly FooterKey[],
  right: string,
  width: number
): string => {
  const left = keys
    .map((item) => `${theme.bold(item.key)} ${theme.fg("muted", item.label)}`)
    .join(theme.fg("dim", " · "));

  const rightText = right ? theme.fg("muted", right) : "";
  const gap = width - visibleWidth(left) - visibleWidth(rightText);

  if (gap < 1) {
    return fit(left, width);
  }

  return `${left}${" ".repeat(gap)}${rightText}`;
};

const renderHeader = (
  theme: Theme,
  snapshot: InspectorSnapshot,
  width: number
) => {
  switch (snapshot.kind) {
    case "state": {
      return {
        subtitle: `state · ${displayText(snapshot.modelLabel)}`,
        summary: renderUsageLine(theme, snapshot.usage),
        note: renderUsageBar(theme, snapshot.usage, width),
        legend: renderLegend(theme, snapshot),
      };
    }

    case "request": {
      return {
        subtitle: "request observation",
        summary: snapshot.request
          ? `Captured ${new Date(snapshot.request.capturedAt).toISOString()}`
          : "No request observed yet",
        note: theme.fg(
          "muted",
          "Payload at before_provider_request: later hooks may change it, and it may be a cache-warming replay"
        ),
        legend: theme.fg(
          "muted",
          `Memory-only · base64 media omitted · no token estimates${snapshot.request?.truncated === true ? " · truncated to 1 MiB" : ""}`
        ),
      };
    }

    case "tools": {
      return {
        subtitle: "tools · registered inventory",
        summary: `${snapshot.tools.length} registered · ${snapshot.activeCount} active · Captured ${new Date(snapshot.capturedAt).toISOString()}`,
        note: theme.fg(
          "muted",
          "Registration and activation at open time; loadouts may hide active declarations"
        ),
        legend: theme.fg(
          "muted",
          "Memory-only · no token estimates · reopen to refresh"
        ),
      };
    }
  }
};

export const renderOverlay = (
  theme: Theme,
  snapshot: InspectorSnapshot,
  layout: Layout,
  body: readonly string[],
  footer: string,
  /** Highlights the tree/preview divider when the preview pane has focus. */
  previewFocused = false
): string[] => {
  const { width, innerWidth, treeWidth, previewWidth, bodyHeight } = layout;

  if (layout.tooSmall) {
    return [truncateToWidth("/context: enlarge terminal", width)];
  }

  const border = (text: string) => theme.fg("border", text);

  const divider = (text: string) =>
    theme.fg(previewFocused ? "borderAccent" : "borderMuted", text);

  const line = (text: string) =>
    `${border("│")}${fit(text, innerWidth)}${border("│")}`;

  const rule = (left: string, junction: string, right: string) =>
    previewWidth > 0
      ? `${border(left)}${border("─".repeat(treeWidth))}${divider(junction)}${border("─".repeat(previewWidth))}${border(right)}`
      : `${border(left)}${border("─".repeat(innerWidth))}${border(right)}`;

  const header = renderHeader(theme, snapshot, innerWidth - 2 * PAD.length);

  const title = truncateToWidth(
    `${theme.bold(theme.fg("accent", "/context"))}${theme.fg("dim", " · ")}${theme.fg("muted", header.subtitle)}`,
    Math.max(0, innerWidth - 4),
    "…"
  );

  const blank = line("");

  const bodyPad =
    previewWidth > 0 ? line(`${" ".repeat(treeWidth)}${divider("│")}`) : blank;

  return [
    border(`╭─ `) +
      title +
      border(
        ` ${"─".repeat(Math.max(0, innerWidth - 3 - visibleWidth(title)))}╮`
      ),
    ...(layout.roomy ? [blank] : []),
    line(`${PAD}${header.summary}`),
    line(`${PAD}${header.note}`),
    ...(layout.showLegend ? [line(`${PAD}${header.legend}`)] : []),
    ...(layout.roomy ? [blank] : []),
    rule("├", "┬", "┤"),
    ...(layout.roomy ? [bodyPad] : []),
    ...Array.from({ length: bodyHeight }, (_, index) =>
      line(body[index] ?? "")
    ),
    rule("├", "┴", "┤"),
    line(`${PAD}${footer}`),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ];
};
