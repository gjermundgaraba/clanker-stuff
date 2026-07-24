import path from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatResetDuration } from "./format.js";
import type { GitStatus } from "./git.js";
import { providerDisplayName } from "./providers.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export type FooterTheme = Pick<Theme, "fg">;

type ThemeColor = Parameters<Theme["fg"]>[0];

export interface ContextInfo {
  percent: number;
  used: number;
  total: number;
}

export interface FooterState {
  context: ContextInfo;
  cwd: string;
  git: GitStatus | null;
  home: string | undefined;
  modelName: string;
  nowMs: number;
  reasoning: boolean;
  thinkingLevel: string;
  usage: UsageSnapshot | null;
}

const CTX_GAUGE_WIDTH = 12;
const BAR_FILLED = "━";
const BAR_EMPTY = "─";

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
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
  sep: string
): string[] => {
  const lines: string[] = [];
  let current = "";

  for (const rawSegment of segments.filter(Boolean)) {
    const segment = truncateToWidth(rawSegment, width);
    if (current.length === 0) {
      current = segment;
      continue;
    }
    const candidate = current + sep + segment;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = segment;
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
  if (percent >= 50) {
    return "accent";
  }
  return "success";
};

const usageColor = (usedPercent: number): ThemeColor => {
  if (usedPercent >= 92) {
    return "error";
  }
  if (usedPercent >= 85) {
    return "warning";
  }
  return "success";
};

const renderBar = (
  percent: number,
  barWidth: number,
  color: ThemeColor,
  theme: FooterTheme
): string => {
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  return (
    theme.fg(color, BAR_FILLED.repeat(filled)) +
    theme.fg("dim", BAR_EMPTY.repeat(empty))
  );
};

const renderContextGauge = (
  context: ContextInfo,
  theme: FooterTheme,
  options: { barWidth: number; includeCounts: boolean }
): string => {
  const { barWidth } = options;
  const clamped = clampPercent(context.percent);
  const bar = renderBar(clamped, barWidth, contextColor(clamped), theme);
  const pct = `${Math.round(clamped)}%`;
  const counts =
    !options.includeCounts || context.total <= 0
      ? ""
      : ` ${formatTokenCount(context.used)}/${formatTokenCount(context.total)}`;
  return `${theme.fg("dim", "ctx ")}${bar} ${theme.fg("dim", pct + counts)}`;
};

const renderUsageWindow = (
  window: UsageWindow,
  nowMs: number,
  theme: FooterTheme,
  options: { barWidth: number; includeReset: boolean }
): string => {
  const dim = (s: string): string => theme.fg("dim", s);
  const used = 100 - window.remainingPercent;
  const bar = renderBar(used, options.barWidth, usageColor(used), theme);
  const pct = dim(`${Math.round(used)}%`);
  const reset =
    !options.includeReset || window.resetsAt === undefined
      ? ""
      : ` ${dim(formatResetDuration(window.resetsAt, nowMs))}`;
  return `${dim(window.label)} ${bar} ${pct}${reset}`;
};

const renderUsageLine = (
  usage: UsageSnapshot,
  nowMs: number,
  width: number,
  theme: FooterTheme
): string[] => {
  const sep = ` ${theme.fg("dim", ">")} `;
  const plan =
    usage.planLabel === undefined || usage.planLabel.length === 0
      ? ""
      : ` (${usage.planLabel})`;
  const provider = `${providerDisplayName(usage.provider)}${plan}`;
  const variants = (window: UsageWindow): [string, string] => [
    renderUsageWindow(window, nowMs, theme, {
      barWidth: 10,
      includeReset: true,
    }),
    renderUsageWindow(window, nowMs, theme, {
      barWidth: 6,
      includeReset: false,
    }),
  ];
  const segments: string[] = [
    theme.fg("accent", provider),
    ...usage.windows.map((window) =>
      selectFooterVariant(width, variants(window))
    ),
  ];
  return wrapFooterSegments(segments, width, sep);
};

const renderGit = (git: GitStatus, theme: FooterTheme): string => {
  if (git.branch === null) {
    return "";
  }
  const branchColor = git.dirty ? "warning" : "success";
  let text = theme.fg(branchColor, git.branch);
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
  const sep = ` ${theme.fg("dim", ">")} `;

  let pwd = state.cwd;
  if (
    state.home !== undefined &&
    state.home.length > 0 &&
    (pwd === state.home || pwd.startsWith(`${state.home}${path.sep}`))
  ) {
    pwd = `~${pwd.slice(state.home.length)}`;
  }

  const pwdStr = theme.fg("accent", pwd);
  const branchStr = state.git === null ? "" : renderGit(state.git, theme);

  const plainModelStr = theme.fg("muted", state.modelName);
  const modelStr =
    state.reasoning && state.thinkingLevel !== "off"
      ? `${plainModelStr} ${theme.fg("dim", ">")} ${theme.fg("accent", state.thinkingLevel)}`
      : plainModelStr;

  const locationBlock =
    branchStr.length === 0
      ? pwdStr
      : selectFooterVariant(width, [
          pwdStr + sep + branchStr,
          pwdStr,
          branchStr,
        ]);

  const statusBlocks = [
    locationBlock,
    selectFooterVariant(
      width,
      modelStr === plainModelStr ? [plainModelStr] : [modelStr, plainModelStr]
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
  ];

  const lines = wrapFooterSegments(statusBlocks, width, sep);
  if (state.usage !== null) {
    lines.push(...renderUsageLine(state.usage, state.nowMs, width, theme));
  }
  return lines;
};
