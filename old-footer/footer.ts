import path from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { GitStatus } from "./git.js";

export type FooterTheme = Pick<Theme, "fg">;

type ThemeColor = Parameters<Theme["fg"]>[0];

export interface ContextInfo {
  percent: number;
  total: number;
  used: number;
}

export interface FooterState {
  codexFast: boolean;
  context: ContextInfo;
  cwd: string;
  extensionStatuses: string[];
  git: GitStatus | null;
  home: string | undefined;
  modelName: string;
  reasoning: boolean;
  thinkingLevel: string;
}

const CTX_GAUGE_WIDTH = 12;
const BAR_FILLED = "━";
const BAR_EMPTY = "─";

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return Number.isInteger(millions)
      ? `${millions}M`
      : `${millions.toFixed(1)}M`;
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
};

const selectFooterVariant = (
  width: number,
  variants: [string, ...string[]]
): string => {
  let [fallback] = variants;
  for (const variant of variants) {
    if (visibleWidth(variant) <= width) {
      return variant;
    }
    fallback = variant;
  }
  return fallback;
};

const wrapFooterSegments = (
  segments: string[],
  width: number,
  separator: string
): string[] => {
  const lines: string[] = [];
  let current = "";
  for (const rawSegment of segments.filter(Boolean)) {
    const segment = truncateToWidth(rawSegment, width);
    if (current.length === 0) {
      current = segment;
      continue;
    }
    const candidate = current + separator + segment;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = segment;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
};

const contextColor = (percent: number): ThemeColor => {
  if (percent >= 90) {
    return "error";
  }
  if (percent >= 70) {
    return "warning";
  }
  return percent >= 50 ? "accent" : "success";
};

const renderContextGauge = (
  context: ContextInfo,
  theme: FooterTheme,
  options: { barWidth: number; includeCounts: boolean }
): string => {
  const clamped = clampPercent(context.percent);
  const filled = Math.round((clamped / 100) * options.barWidth);
  const bar =
    theme.fg(contextColor(clamped), BAR_FILLED.repeat(filled)) +
    theme.fg("dim", BAR_EMPTY.repeat(options.barWidth - filled));
  const percent = `${Math.round(clamped)}%`;
  const counts =
    options.includeCounts && context.total > 0
      ? ` ${formatTokenCount(context.used)}/${formatTokenCount(context.total)}`
      : "";
  return `${theme.fg("dim", "ctx ")}${bar} ${theme.fg("dim", percent + counts)}`;
};

const renderGit = (git: GitStatus, theme: FooterTheme): string => {
  if (git.branch === null) {
    return "";
  }
  let text = theme.fg(git.dirty ? "warning" : "success", git.branch);
  if (git.dirty) {
    text += theme.fg("warning", " *");
  }
  if (git.ahead > 0) {
    text += theme.fg("success", ` ↑${git.ahead}`);
  }
  if (git.behind > 0) {
    text += theme.fg("error", ` ↓${git.behind}`);
  }
  return text;
};

export const renderFooter = (
  state: FooterState,
  width: number,
  theme: FooterTheme
): string[] => {
  const separator = ` ${theme.fg("dim", ">")} `;
  const { cwd: initialCwd } = state;
  let cwd = initialCwd;
  if (
    state.home !== undefined &&
    state.home.length > 0 &&
    (cwd === state.home || cwd.startsWith(`${state.home}${path.sep}`))
  ) {
    cwd = `~${cwd.slice(state.home.length)}`;
  }

  const cwdText = theme.fg("accent", cwd);
  const gitText = state.git === null ? "" : renderGit(state.git, theme);
  const plainModel =
    theme.fg("muted", state.modelName) +
    (state.codexFast ? ` ${theme.fg("warning", "⚡")}` : "");
  const model =
    state.reasoning && state.thinkingLevel !== "off"
      ? `${plainModel} ${theme.fg("dim", ">")} ${theme.fg("accent", state.thinkingLevel)}`
      : plainModel;
  const location =
    gitText.length === 0
      ? cwdText
      : selectFooterVariant(width, [
          cwdText + separator + gitText,
          cwdText,
          gitText,
        ]);
  const lines = wrapFooterSegments(
    [
      location,
      selectFooterVariant(
        width,
        model === plainModel ? [plainModel] : [model, plainModel]
      ),
      selectFooterVariant(width, [
        renderContextGauge(state.context, theme, {
          barWidth: CTX_GAUGE_WIDTH,
          includeCounts: true,
        }),
        renderContextGauge(state.context, theme, {
          barWidth: 6,
          includeCounts: false,
        }),
      ]),
    ],
    width,
    separator
  );
  if (state.extensionStatuses.length > 0) {
    lines.push(
      truncateToWidth(
        state.extensionStatuses.join(" "),
        width,
        theme.fg("dim", "...")
      )
    );
  }
  return lines;
};
