import { stripVTControlCharacters } from "node:util";
import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ContextSnapshot, Tone } from "./snapshot.js";
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

export const displayText = (text: string): string =>
  stripVTControlCharacters(text).replaceAll("\r", "");

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

export interface UsageSegment {
  readonly label: string;
  readonly tokens: number;
  readonly color: ThemeColor;
}

export const usageSegments = (snapshot: ContextSnapshot): UsageSegment[] => {
  const sum = (parts: readonly { estimatedTokens: number }[]) =>
    parts.reduce((total, part) => total + part.estimatedTokens, 0);
  return [
    { label: "system", tokens: snapshot.system.estimatedTokens, color: "accent" },
    { label: "tools", tokens: sum(snapshot.tools), color: "warning" },
    { label: "messages", tokens: sum(snapshot.messages), color: "success" },
  ];
};

/**
 * Splits exactly `cells` across weights by largest remainder. When the budget allows, every
 * non-zero weight keeps at least one cell, taken from the largest allocation.
 */
export const distributeCells = (weights: readonly number[], cells: number): number[] => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (cells <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / total) * cells);
  const result = exact.map((value) => Math.floor(value));
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);
  let remaining = cells - result.reduce((sum, value) => sum + value, 0);
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    result[index] += 1;
    remaining -= 1;
  }
  const nonEmpty = weights.filter((weight) => weight > 0).length;
  if (cells >= nonEmpty) {
    for (let index = 0; index < weights.length; index += 1) {
      if (weights[index] === 0 || result[index] > 0) continue;
      const donor = result.indexOf(Math.max(...result));
      result[donor] -= 1;
      result[index] += 1;
    }
  }
  return result;
};

export const renderUsageBar = (
  theme: Theme,
  usage: ContextUsage | undefined,
  segments: readonly UsageSegment[],
  width: number,
): string => {
  if (width <= 0) return "";
  const used =
    usage?.tokens == null || usage.contextWindow <= 0
      ? 0
      : Math.max(0, Math.min(width, Math.round((usage.tokens / usage.contextWindow) * width)));
  const cells = distributeCells(
    segments.map((segment) => segment.tokens),
    used,
  );
  const filled = cells.reduce((sum, value) => sum + value, 0);
  return (
    segments.map((segment, index) => theme.fg(segment.color, "█".repeat(cells[index]))).join("") +
    theme.fg("scrollbarTrack", "░".repeat(Math.max(0, width - filled)))
  );
};

export const renderUsageLine = (theme: Theme, usage: ContextUsage | undefined): string => {
  if (usage?.tokens == null || usage.contextWindow <= 0) {
    return theme.fg("muted", "Pi context usage: unknown");
  }
  const percent = (usage.tokens / usage.contextWindow) * 100;
  const tone: ThemeColor = percent >= 90 ? "error" : percent >= 70 ? "warning" : "accent";
  return [
    theme.bold(count(usage.tokens)),
    theme.fg("muted", ` / ${count(usage.contextWindow)} tokens`),
    theme.fg("dim", " · "),
    theme.fg(tone, `${percent.toFixed(1)}% used`),
    theme.fg("dim", " · "),
    theme.fg("muted", `${count(Math.max(0, usage.contextWindow - usage.tokens))} free`),
  ].join("");
};

export const renderLegend = (
  theme: Theme,
  usage: ContextUsage | undefined,
  segments: readonly UsageSegment[],
): string => {
  const total = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const items = segments.map(
    (segment) =>
      theme.fg(segment.color, "■ ") +
      segment.label +
      theme.fg(
        "muted",
        ` ${estimate(segment.tokens)}${total > 0 ? ` · ${Math.round((segment.tokens / total) * 100)}%` : ""}`,
      ),
  );
  if (usage?.tokens != null && usage.contextWindow > 0) {
    items.push(
      theme.fg("scrollbarTrack", "░ ") +
        "free" +
        theme.fg("muted", ` ${count(Math.max(0, usage.contextWindow - usage.tokens))}`),
    );
  }
  return items.join("   ");
};

const toneColor = (tone: Tone): ThemeColor => (tone === "code" ? "mdCode" : tone);

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
): string[] => {
  const showBar = width >= ROW_BAR_MIN_TREE_WIDTH;
  const labelWidth = Math.max(1, width - 2 - (showBar ? ROW_BAR_WIDTH + 1 : 0) - countWidth - 2);
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
      theme.fg("muted", estimate(row.node.estimatedTokens).padStart(countWidth)),
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
  snapshot: ContextSnapshot,
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
    `${theme.bold(theme.fg("accent", "/context"))}${theme.fg("dim", " · ")}${theme.fg("muted", displayText(snapshot.modelLabel))}`,
    Math.max(0, innerWidth - 4),
    "…",
  );
  const segments = usageSegments(snapshot);
  const blank = line("");
  // Keep the pane divider continuous through the spacing row above the body.
  const bodyPad = previewWidth > 0 ? line(`${" ".repeat(treeWidth)}${divider("│")}`) : blank;
  return [
    // "╭─ " + title + " " + dashes + "╮" must span the full width.
    border(`╭─ `) +
      title +
      border(` ${"─".repeat(Math.max(0, innerWidth - 3 - visibleWidth(title)))}╮`),
    ...(layout.roomy ? [blank] : []),
    line(`${PAD}${renderUsageLine(theme, snapshot.usage)}`),
    line(`${PAD}${renderUsageBar(theme, snapshot.usage, segments, innerWidth - 2 * PAD.length)}`),
    ...(layout.showLegend ? [line(`${PAD}${renderLegend(theme, snapshot.usage, segments)}`)] : []),
    ...(layout.roomy ? [blank] : []),
    rule("├", "┬", "┤"),
    ...(layout.roomy ? [bodyPad] : []),
    ...Array.from({ length: bodyHeight }, (_, index) => line(body[index] ?? "")),
    rule("├", "┴", "┤"),
    line(`${PAD}${footer}`),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ];
};
