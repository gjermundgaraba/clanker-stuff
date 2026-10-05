import { percentTone } from "@clanker-stuff/pi-tones";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ContextSnapshot, InspectorSnapshot, NodeTone } from "./snapshot.js";
import type { FlatRow } from "./tree.js";

type ThemeColor = Parameters<Theme["fg"]>[0];

/** Smallest width where the title corners "╭─ " and " ╮" fit around an empty title. */
const MIN_WIDTH = 5;

const MIN_HEIGHT = 10;

/** Overlays shorter than this drop the legend line so the body keeps usable rows. */
const LEGEND_MIN_HEIGHT = 14;

/** Overlays shorter than this drop the blank spacing rows around the header and body. */
const ROOMY_MIN_HEIGHT = 20;

/** Header (title, usage, bar, rule) plus footer (rule, help, bottom), excluding legend and spacing. */
const CHROME_ROWS = 7;

/** Horizontal padding inside the frame for header, footer and preview text. */
export const PAD = "  ";

/** Share of the terminal the overlay occupies; the runtime's overlay option derives from this too. */
export const OVERLAY_HEIGHT_RATIO = 0.9;

/** Narrowest overlay that shows the tree and preview side by side. */
const SPLIT_MIN_WIDTH = 80;

const ROW_BAR_WIDTH = 8;

const ROW_BAR_MIN_TREE_WIDTH = 40;

export const fit = (text: string, width: number): string => {
  const clipped = truncateToWidth(text, width, "…");

  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

const count = (value: number): string => value.toLocaleString("en-US");

/** Breakdown figures are estimates everywhere they appear: tree rows, legend and preview header. */
const estimate = (value: number): string => `~${count(value)}`;

export const overlayHeight = (terminalRows: number): number =>
  Math.max(1, Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO));

export const layoutOverlay = (width: number, height: number, detail: boolean) => {
  const innerWidth = Math.max(0, width - 2);
  const split = width >= SPLIT_MIN_WIDTH && !detail;
  const treeWidth = split ? Math.floor(innerWidth * 0.42) : innerWidth;
  const showLegend = height >= LEGEND_MIN_HEIGHT;
  const roomy = height >= ROOMY_MIN_HEIGHT;
  const bodyHeight = Math.max(0, height - CHROME_ROWS - (showLegend ? 1 : 0) - (roomy ? 3 : 0));

  return {
    width,
    innerWidth,
    treeWidth,
    previewWidth: split ? innerWidth - treeWidth - 1 : 0,
    showLegend,
    /** Blank rows below the title, above the pane rule, and at the top of the panes. */
    roomy,
    bodyTop: 4 + (showLegend ? 1 : 0) + (roomy ? 3 : 0),
    bodyHeight,
    /** Preview label row plus its rule; the rule is dropped when it would leave no content row. */
    previewHeaderRows: bodyHeight > 3 ? 2 : 1,
    tooSmall: width < MIN_WIDTH || height < MIN_HEIGHT,
  };
};

export type Layout = ReturnType<typeof layoutOverlay>;

/** Measured context usage as a share of the window, or undefined when Pi does not know it. */
const usedPercent = (usage: ContextUsage | undefined): number | undefined =>
  usage?.tokens == null || usage.contextWindow <= 0
    ? undefined
    : (usage.tokens / usage.contextWindow) * 100;

/** Pi's measured usage only; estimates belong to the legend, not the bar. */
export const renderUsageBar = (theme: Theme, usage: ContextUsage | undefined, width: number) => {
  if (width <= 0) return "";
  const percent = usedPercent(usage) ?? 0;
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));

  return (
    theme.fg(percentTone(percent), "█".repeat(filled)) +
    theme.fg("scrollbarTrack", "░".repeat(width - filled))
  );
};

export const renderUsageLine = (theme: Theme, usage: ContextUsage | undefined): string => {
  const percent = usedPercent(usage);

  if (usage?.tokens == null || percent === undefined) {
    return theme.fg("muted", "Pi context usage: unknown");
  }

  return [
    theme.bold(count(usage.tokens)),
    theme.fg("muted", ` / ${count(usage.contextWindow)} tokens`),
    theme.fg("dim", " · "),
    theme.fg(percentTone(percent), `${percent.toFixed(1)}% used`),
    theme.fg("dim", " · "),
    theme.fg("muted", `${count(Math.max(0, usage.contextWindow - usage.tokens))} free`),
  ].join("");
};

export const renderLegend = (theme: Theme, snapshot: ContextSnapshot): string => {
  const sum = (parts: readonly { estimatedTokens: number }[]) =>
    parts.reduce((total, part) => total + part.estimatedTokens, 0);

  const estimates = [
    ["system", snapshot.system.estimatedTokens],
    ["tools", sum(snapshot.tools)],
    ["messages", sum(snapshot.messages)],
  ] as const;

  const total = estimates.reduce((sum, [, tokens]) => sum + tokens, 0);

  return estimates
    .map(
      ([label, tokens]) =>
        label +
        theme.fg(
          "muted",
          ` ${estimate(tokens)}${total > 0 ? ` · ${Math.round((tokens / total) * 100)}%` : ""}`,
        ),
    )
    .join(theme.fg("dim", "   "));
};

const toneColor = (tone: NodeTone): ThemeColor => (tone === "code" ? "mdCode" : tone);

const renderRowBar = (theme: Theme, share: number): string => {
  const filled = Math.max(share > 0 ? 1 : 0, Math.round(share * ROW_BAR_WIDTH));

  return (
    theme.fg("muted", "█".repeat(filled)) +
    theme.fg("scrollbarTrack", "░".repeat(ROW_BAR_WIDTH - filled))
  );
};

/** Width of the token column, computed over all rows so it does not shift while scrolling. */
export const countColumnWidth = (rows: readonly FlatRow[]): number =>
  Math.max(6, ...rows.map((row) => estimate(row.node.estimatedTokens).length));

export const renderTreeRows = (
  theme: Theme,
  rows: readonly FlatRow[],
  selected: number,
  width: number,
  countWidth: number,
  showEstimates = true,
): string[] => {
  const showBar = showEstimates && width >= ROW_BAR_MIN_TREE_WIDTH;

  const labelWidth = Math.max(
    1,
    width - 2 - (showBar ? ROW_BAR_WIDTH + 1 : 0) - (showEstimates ? countWidth + 2 : 0),
  );

  return rows.map((row, index) => {
    const active = index === selected;
    const isGroup = row.node.children.length > 0;
    const branch = row.depth === 0 ? "" : `${"  ".repeat(row.depth)}${row.last ? "└ " : "├ "}`;
    const glyph = row.depth === 0 && isGroup ? (row.expanded ? "▾ " : "▸ ") : "  ";
    const name = theme.fg(toneColor(row.node.tone), displayText(row.node.label));

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
        ? theme.fg("muted", estimate(row.node.estimatedTokens).padStart(countWidth))
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
  total: number,
): string[] => {
  if (height <= 0) return [];

  if (total <= height) return Array.from({ length: height }, () => " ");
  const thumb = Math.max(1, Math.round((height / total) * height));
  const start = Math.round((offset / (total - height)) * (height - thumb));

  return Array.from({ length: height }, (_, index) =>
    index >= start && index < start + thumb
      ? theme.fg("scrollbarThumb", "┃")
      : theme.fg("dim", "│"),
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
  width: number,
): string => {
  const left = keys
    .map((item) => `${theme.bold(item.key)} ${theme.fg("muted", item.label)}`)
    .join(theme.fg("dim", " · "));

  const rightText = right ? theme.fg("muted", right) : "";
  const gap = width - visibleWidth(left) - visibleWidth(rightText);

  if (gap < 1) return fit(left, width);

  return `${left}${" ".repeat(gap)}${rightText}`;
};

export const renderOverlay = (
  theme: Theme,
  snapshot: InspectorSnapshot,
  layout: Layout,
  body: readonly string[],
  footer: string,
  /** Highlights the tree/preview divider when the preview pane has focus. */
  previewFocused = false,
): string[] => {
  const { width, innerWidth, treeWidth, previewWidth, bodyHeight } = layout;

  if (layout.tooSmall) {
    return [truncateToWidth("/context: enlarge terminal", width)];
  }

  const border = (text: string) => theme.fg("border", text);
  const divider = (text: string) => theme.fg(previewFocused ? "borderAccent" : "borderMuted", text);
  const line = (text: string) => `${border("│")}${fit(text, innerWidth)}${border("│")}`;

  const rule = (left: string, junction: string, right: string) =>
    previewWidth > 0
      ? `${border(left)}${border("─".repeat(treeWidth))}${divider(junction)}${border("─".repeat(previewWidth))}${border(right)}`
      : `${border(left)}${border("─".repeat(innerWidth))}${border(right)}`;

  const title = truncateToWidth(
    `${theme.bold(theme.fg("accent", "/context"))}${theme.fg("dim", " · ")}${theme.fg("muted", snapshot.kind === "state" ? `state · ${displayText(snapshot.modelLabel)}` : "request observation")}`,
    Math.max(0, innerWidth - 4),
    "…",
  );

  const blank = line("");
  // Keep the pane divider continuous through the spacing row above the body.
  const bodyPad = previewWidth > 0 ? line(`${" ".repeat(treeWidth)}${divider("│")}`) : blank;

  return [
    // "╭─ " + title + " " + dashes + "╮" must span the full width.
    border(`╭─ `) +
      title +
      border(` ${"─".repeat(Math.max(0, innerWidth - 3 - visibleWidth(title)))}╮`),
    ...(layout.roomy ? [blank] : []),
    line(
      `${PAD}${
        snapshot.kind === "state"
          ? renderUsageLine(theme, snapshot.usage)
          : snapshot.request
            ? `Captured ${new Date(snapshot.request.capturedAt).toISOString()}`
            : "No request observed yet"
      }`,
    ),
    line(
      `${PAD}${
        snapshot.kind === "state"
          ? renderUsageBar(theme, snapshot.usage, innerWidth - 2 * PAD.length)
          : theme.fg(
              "muted",
              "Payload at before_provider_request: later hooks may change it, and it may be a cache-warming replay",
            )
      }`,
    ),
    ...(layout.showLegend
      ? [
          line(
            `${PAD}${
              snapshot.kind === "state"
                ? renderLegend(theme, snapshot)
                : theme.fg(
                    "muted",
                    `Memory-only · base64 media omitted · no token estimates${snapshot.request?.truncated ? " · truncated to 1 MiB" : ""}`,
                  )
            }`,
          ),
        ]
      : []),
    ...(layout.roomy ? [blank] : []),
    rule("├", "┬", "┤"),
    ...(layout.roomy ? [bodyPad] : []),
    ...Array.from({ length: bodyHeight }, (_, index) => line(body[index] ?? "")),
    rule("├", "┴", "┤"),
    line(`${PAD}${footer}`),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ];
};
