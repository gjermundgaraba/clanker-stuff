/* oxlint-disable eslint/no-nested-ternary -- bounded numeric formatters stay adjacent */
import os from "node:os";
import path from "node:path";

import type {
  FooterContent,
  FooterSpan,
  FooterTone,
  FooterWidgetSnapshot,
} from "@clanker-stuff/footer-protocol";
import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { GitStatus } from "./git.js";

export type FooterSource = "builtin" | "native" | "rich";

export interface LiveWidget {
  snapshot: FooterWidgetSnapshot;
  source: FooterSource;
  nativeAnsi?: boolean;
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

export interface BuiltinWidgetOptions {
  git: GitStatus | null;
  now: number;
  session: SessionTotals;
  thinkingLevel: string;
}

interface UsageLike {
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  input?: number;
  output?: number;
}

const span = (
  text: string,
  tone: FooterTone = "text",
  bold = false
): FooterContent => [{ bold, text, tone }];

const builtin = (snapshot: FooterWidgetSnapshot): LiveWidget => ({
  snapshot,
  source: "builtin",
});

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

const percentTone = (percent: number): FooterTone =>
  percent >= 90 ? "error" : percent >= 70 ? "warning" : "text";

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
  return safe === 0
    ? "$0"
    : safe < 0.01
      ? `$${safe.toFixed(3)}`
      : `$${safe.toFixed(2)}`;
};

const formatElapsed = (milliseconds: number): string => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
};

const abbreviateHome = (cwd: string): string => {
  const home = os.homedir();
  return home.length > 0 &&
    (cwd === home || cwd.startsWith(`${home}${path.sep}`))
    ? `~${cwd.slice(home.length)}`
    : cwd;
};

const cwdWidget = (cwd: string): LiveWidget =>
  builtin({
    content: span(abbreviateHome(cwd), "accent"),
    icon: {
      glyphs: { ascii: "cwd", nerd: "", unicode: "▸" },
      tone: "accent",
    },
    id: "footer.cwd",
    label: "Working directory",
    truncate: "start",
  });

const modelWidget = (ctx: ExtensionContext): LiveWidget => {
  const { model } = ctx;
  if (!model) {
    return builtin({
      content: span("no model", "muted"),
      id: "footer.model",
      label: "Model",
    });
  }

  let ambiguous = false;
  try {
    ambiguous = ctx.modelRegistry
      .getAvailable()
      .some(
        (candidate) =>
          candidate !== model &&
          candidate.provider !== model.provider &&
          (candidate.name === model.name || candidate.id === model.id)
      );
  } catch {
    // A registry failure should not remove the active model from the footer.
  }
  let { provider } = model;
  if (ambiguous) {
    try {
      provider = ctx.modelRegistry.getProviderDisplayName(model.provider);
    } catch {
      // The provider ID is already a safe fallback.
    }
  }
  const full = ambiguous ? `${provider} / ${model.name}` : model.name;
  return builtin({
    content: span(full, "muted"),
    icon: {
      glyphs: { ascii: "model", nerd: "󰧑", unicode: "◆" },
      tone: "muted",
    },
    id: "footer.model",
    label: "Model",
  });
};

const thinkingWidget = (thinkingLevel: string): LiveWidget =>
  builtin({
    content: span(thinkingLevel === "off" ? "" : thinkingLevel, "accent"),
    icon: {
      glyphs: { ascii: "think", nerd: "󰔏", unicode: "◇" },
      tone: "accent",
    },
    id: "footer.thinking",
    label: "Thinking",
  });

const contextWidget = (ctx: ExtensionContext, now: number): LiveWidget => {
  const usage = ctx.getContextUsage();
  const percent = clampPercent(usage?.percent ?? 0);
  const rounded = `${Math.round(percent)}%`;
  const filled = Math.round((percent / 100) * 12);
  const bar: FooterSpan[] = [
    { text: "━".repeat(filled), tone: percentTone(percent) },
    { text: "─".repeat(12 - filled), tone: "dim" },
    { text: ` ${rounded}`, tone: percentTone(percent) },
  ];
  if (
    usage?.tokens !== null &&
    usage?.tokens !== undefined &&
    usage.contextWindow > 0
  ) {
    bar.push({
      text: ` ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)}`,
      tone: "dim",
    });
  }
  return builtin({
    content: bar,
    health: {
      state: usage?.tokens === null ? "loading" : "ready",
      updatedAt: now,
    },
    icon: {
      glyphs: { ascii: "ctx", nerd: "󰍛", unicode: "◫" },
      tone: "dim",
    },
    id: "footer.context",
    label: "Context",
  });
};

const gitWidgets = (git: GitStatus | null): LiveWidget[] => {
  const branch = git?.branch ?? "";
  const details =
    git === null
      ? ""
      : [
          git.staged > 0 ? `+${git.staged}` : "",
          git.unstaged > 0 ? `~${git.unstaged}` : "",
          git.untracked > 0 ? `?${git.untracked}` : "",
          git.ahead > 0 ? `↑${git.ahead}` : "",
          git.behind > 0 ? `↓${git.behind}` : "",
        ]
          .filter(Boolean)
          .join(" ");
  return [
    builtin({
      content: span(branch, details ? "warning" : "success"),
      icon: {
        glyphs: { ascii: "git", nerd: "", unicode: "⑂" },
        tone: details ? "warning" : "success",
      },
      id: "footer.git",
      label: "Git branch",
    }),
    builtin({
      content: span(details, "warning"),
      id: "footer.git.details",
      label: "Git details",
    }),
  ];
};

const sessionWidget = (totals: SessionTotals, now: number): LiveWidget => {
  const elapsed = formatElapsed(
    totals.startedAt === undefined ? 0 : now - totals.startedAt
  );
  const cost = formatCost(totals.cost);
  const trimmedName = totals.name?.trim();
  const name =
    trimmedName === undefined || trimmedName.length === 0
      ? "session"
      : trimmedName;
  const full = `${name} ${elapsed} in ${formatTokenCount(totals.input)} out ${formatTokenCount(totals.output)} cache ${formatTokenCount(totals.cacheRead)}/${formatTokenCount(totals.cacheWrite)} ${cost}`;
  return builtin({
    content: span(full, "dim"),
    icon: {
      glyphs: { ascii: "session", nerd: "󱎫", unicode: "◷" },
      tone: "dim",
    },
    id: "footer.session",
    label: "Session",
  });
};

const usageFromEntry = (entry: SessionEntry): UsageLike | undefined => {
  if (entry.type === "message") {
    const { message } = entry;
    return "usage" in message ? message.usage : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
};

export const collectSessionTotals = (ctx: ExtensionContext): SessionTotals => {
  const totals: SessionTotals = {
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    input: 0,
    output: 0,
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    const usage = usageFromEntry(entry);
    if (!usage) {
      continue;
    }
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  totals.name = ctx.sessionManager.getSessionName();
  const timestamp = ctx.sessionManager.getHeader()?.timestamp;
  if (timestamp !== undefined) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) {
      totals.startedAt = parsed;
    }
  }
  return totals;
};

export const buildBuiltinWidgets = (
  ctx: ExtensionContext,
  options: BuiltinWidgetOptions
): Map<string, LiveWidget> => {
  const values = [
    cwdWidget(ctx.cwd),
    modelWidget(ctx),
    thinkingWidget(options.thinkingLevel),
    contextWidget(ctx, options.now),
    ...gitWidgets(options.git),
    sessionWidget(options.session, options.now),
  ];
  return new Map(values.map((widget) => [widget.snapshot.id, widget]));
};
