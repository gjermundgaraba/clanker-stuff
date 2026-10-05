import os from "node:os";
import path from "node:path";

import { inspectModelHistory } from "@clanker-stuff/model-history";
import { percentTone } from "@clanker-stuff/pi-tones";
import type { Tone } from "@clanker-stuff/pi-tones";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { IconFamily } from "./config.js";
import type { GitDetails } from "./git.js";

export interface Span {
  text: string;
  tone: Tone;
}

export interface BuiltinWidget {
  id: string;
  content: Span[];
  icon?: Record<IconFamily, string>;
  /** Keep the end visible; otherwise the widget's side decides. */
  truncate?: "start";
}

export interface BuiltinWidgetOptions {
  branch: string | null;
  details: GitDetails | undefined;
  now: number;
  thinkingLevel: string;
}

export interface SessionTotals {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  input: number;
  output: number;
  startedAt?: number;
  name?: string;
}

interface UsageLike {
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  input?: number;
  output?: number;
}

type SessionTotalsContext = {
  sessionManager: {
    getEntries: () => SessionEntry[];
    getHeader: () => { timestamp: string } | null;
    getSessionName: () => string | undefined;
  };
};

const span = (text: string, tone: Tone): Span[] => [{ text, tone }];

export const formatTokenCount = (tokens: number): string => {
  const safe = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;

  if (safe >= 1_000_000) {
    const millions = safe / 1_000_000;

    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }

  return safe >= 1000 ? `${Math.round(safe / 1000)}k` : `${Math.round(safe)}`;
};

const formatCost = (cost: number): string => {
  const safe = Number.isFinite(cost) ? Math.max(0, cost) : 0;

  return safe === 0 ? "$0" : safe < 0.01 ? `$${safe.toFixed(3)}` : `$${safe.toFixed(2)}`;
};

const formatElapsed = (milliseconds: number): string => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
};

const abbreviateHome = (cwd: string): string => {
  const home = os.homedir();

  return home.length > 0 && (cwd === home || cwd.startsWith(`${home}${path.sep}`))
    ? `~${cwd.slice(home.length)}`
    : cwd;
};

const modelWidget = (
  ctx: ExtensionContext,
  latest: AssistantMessage | undefined,
): BuiltinWidget => {
  const { model } = ctx;

  const base = {
    icon: { ascii: "model", nerd: "󰧑", unicode: "◆" },
    id: "footer.model",
  };

  if (!model) return { ...base, content: span("no model", "muted") };

  // Name the provider only when another available provider offers the same model name or ID.
  const ambiguous = ctx.modelRegistry
    .getAvailable()
    .some(
      (candidate) =>
        candidate.provider !== model.provider &&
        (candidate.name === model.name || candidate.id === model.id),
    );

  const selected = ambiguous
    ? `${ctx.modelRegistry.getProviderDisplayName(model.provider)} / ${model.name}`
    : model.name;

  const differs = latest && (latest.provider !== model.provider || latest.model !== model.id);

  return {
    ...base,
    content: span(
      differs ? `selected: ${selected} · last: ${latest.provider}/${latest.model}` : selected,
      "muted",
    ),
  };
};

const thinkingWidget = (
  thinkingLevel: string,
  latest: AssistantMessage | undefined,
): BuiltinWidget => ({
  content: span(
    latest?.thinkingLevel !== undefined && latest.thinkingLevel !== thinkingLevel
      ? `selected: ${thinkingLevel} · last: ${latest.thinkingLevel}`
      : thinkingLevel === "off"
        ? ""
        : thinkingLevel,
    "muted",
  ),
  icon: { ascii: "think", nerd: "󰔏", unicode: "◇" },
  id: "footer.thinking",
});

const METER_WIDTH = 12;

const contextWidget = (ctx: ExtensionContext): BuiltinWidget => {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

  const base = {
    icon: { ascii: "ctx", nerd: "󰍛", unicode: "◫" },
    id: "footer.context",
  };

  // Pi reports unknown usage after compaction until the next response, and none without a window.
  if (usage?.percent === null || usage?.percent === undefined) {
    return {
      ...base,
      content: [
        { text: "─".repeat(METER_WIDTH), tone: "dim" },
        { text: window > 0 ? ` ?/${formatTokenCount(window)}` : " ?", tone: "muted" },
      ],
    };
  }

  const percent = Math.min(100, Math.max(0, usage.percent));
  const filled = Math.round((percent / 100) * METER_WIDTH);
  const tone = percentTone(percent);

  return {
    ...base,
    content: [
      { text: "━".repeat(filled), tone },
      { text: "─".repeat(METER_WIDTH - filled), tone: "dim" },
      { text: ` ${Math.round(percent)}%`, tone },
      ...(usage.tokens === null
        ? []
        : [
            {
              text: ` ${formatTokenCount(usage.tokens)}/${formatTokenCount(window)}`,
              tone: "dim" as const,
            },
          ]),
    ],
  };
};

const gitWidgets = (branch: string | null, details: GitDetails | undefined): BuiltinWidget[] => [
  {
    content: span(branch ?? "", "text"),
    icon: { ascii: "git", nerd: "", unicode: "⑂" },
    id: "footer.git",
  },
  {
    // A dirty tree is routine; the counts are the marker.
    content: span(
      details === undefined
        ? ""
        : [
            details.staged > 0 ? `+${details.staged}` : "",
            details.unstaged > 0 ? `~${details.unstaged}` : "",
            details.untracked > 0 ? `?${details.untracked}` : "",
            details.ahead > 0 ? `↑${details.ahead}` : "",
            details.behind > 0 ? `↓${details.behind}` : "",
          ]
            .filter(Boolean)
            .join(" "),
      "muted",
    ),
    id: "footer.git.details",
  },
];

const usageFromEntry = (entry: SessionEntry): UsageLike | undefined => {
  if (entry.type === "message") return "usage" in entry.message ? entry.message.usage : undefined;

  return entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
};

export const collectSessionTotals = (ctx: SessionTotalsContext): SessionTotals => {
  const totals: SessionTotals = { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0 };

  for (const entry of ctx.sessionManager.getEntries()) {
    const usage = usageFromEntry(entry);

    if (!usage) continue;

    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }

  const name = ctx.sessionManager.getSessionName();

  if (name !== undefined) totals.name = name;

  const started = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? "");

  if (Number.isFinite(started)) totals.startedAt = started;

  return totals;
};

const sessionWidget = (totals: SessionTotals, now: number): BuiltinWidget => {
  const elapsed = formatElapsed(totals.startedAt === undefined ? 0 : now - totals.startedAt);
  const name = totals.name?.trim() || "session";

  return {
    content: span(
      `${name} ${elapsed} in ${formatTokenCount(totals.input)} out ${formatTokenCount(totals.output)} cache ${formatTokenCount(totals.cacheRead)}/${formatTokenCount(totals.cacheWrite)} ${formatCost(totals.cost)}`,
      "dim",
    ),
    icon: { ascii: "session", nerd: "󱎫", unicode: "◷" },
    id: "footer.session",
  };
};

export const buildBuiltinWidgets = (
  ctx: ExtensionContext,
  options: BuiltinWidgetOptions,
): Map<string, BuiltinWidget> => {
  const { lastSuccessfulResponse: latest } = inspectModelHistory(ctx.sessionManager.getBranch());

  const widgets: BuiltinWidget[] = [
    {
      content: span(abbreviateHome(ctx.cwd), "muted"),
      icon: { ascii: "cwd", nerd: "", unicode: "▸" },
      id: "footer.cwd",
      truncate: "start",
    },
    modelWidget(ctx, latest),
    thinkingWidget(options.thinkingLevel, latest),
    contextWidget(ctx),
    ...gitWidgets(options.branch, options.details),
    sessionWidget(collectSessionTotals(ctx), options.now),
  ];

  return new Map(widgets.map((widget) => [widget.id, widget]));
};
