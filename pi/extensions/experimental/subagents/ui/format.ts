import { FRAME_INTERVAL_MS, wireframe } from "@clanker-stuff/pi-shape-glyphs";
import type { Tone } from "@clanker-stuff/pi-tones";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { Activity } from "../monitor.js";
import { parentAgentPath, ROOT_AGENT_PATH } from "../protocol.js";
import type { AgentNode, AgentUsage } from "../protocol.js";

export type AgentStatus = AgentNode["status"];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How often live surfaces redraw; each mark picks its frame from the clock. */
export const FRAME_MS = 100;

const spinner = (now: number): string =>
  SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? "●";

/** Statuses presentation shows; tools also report agents that do not exist. */
export type DisplayStatus = AgentStatus | "not_found";

const STATUS_LOOK: Record<
  DisplayStatus,
  {
    glyph: string;
    tone: Extract<Tone, "accent" | "error" | "muted" | "success">;
  }
> = {
  completed: { glyph: "✓", tone: "success" },
  errored: { glyph: "✗", tone: "error" },
  interrupted: { glyph: "■", tone: "muted" },
  not_found: { glyph: "✗", tone: "error" },
  running: { glyph: "●", tone: "accent" },
};

export const statusTone = (status: DisplayStatus) => STATUS_LOOK[status].tone;

export const isDisplayStatus = (value: string): value is DisplayStatus =>
  Object.hasOwn(STATUS_LOOK, value);

/** A status as one glyph; tool results are snapshots, so a running agent keeps a dot. */
export const statusGlyph = (theme: Theme, status: DisplayStatus): string =>
  theme.fg(STATUS_LOOK[status].tone, STATUS_LOOK[status].glyph);

/** How the live surfaces mark running agents. */
export interface Marks {
  /** Columns every mark takes, so names line up whatever their status. */
  readonly width: number;
  running: (theme: Theme, path: string, now: number) => string;
}

export const BRAILLE_MARKS: Marks = {
  running: (theme, _path, now) => theme.fg("accent", spinner(now)),
  width: 1,
};

const ORB_COLORS = [
  "cyan",
  "purple",
  "orange",
  "green",
  "pink",
  "blue",
  "yellow",
] as const;

/**
 * Shape-spinner's orb, in one color per top-level agent that its descendants share; root's is gray.
 * Its inks are part of the artwork, so the theme only picks the background they suit.
 */
export const orbMarks = (nodes: () => readonly AgentNode[]): Marks => ({
  running: (theme, path, now) => {
    const tops = nodes().filter(
      (node) => parentAgentPath(node.path) === ROOT_AGENT_PATH
    );

    const index = tops.findIndex(
      (top) => path === top.path || path.startsWith(`${top.path}/`)
    );

    const color = ORB_COLORS[index % ORB_COLORS.length] ?? "gray";

    const { frames } = wireframe("orb", color, theme.appearance);

    return frames[Math.floor(now / FRAME_INTERVAL_MS) % frames.length] ?? "";
  },
  width: 2,
});

/** An agent's mark on a live surface; root has no node and shows a ring while idle. */
export const statusMark = (
  theme: Theme,
  marks: Marks,
  path: string,
  status: DisplayStatus | "idle",
  now: number
): string => {
  if (status === "running") {
    return marks.running(theme, path, now);
  }

  const mark =
    status === "idle" ? theme.fg("muted", "○") : statusGlyph(theme, status);

  return `${mark}${" ".repeat(marks.width - 1)}`;
};

export const fit = (text: string, width: number): string =>
  truncateToWidth(text, width, "…", true);

export const fitRight = (text: string, width: number): string => {
  if (width <= 0) {
    return "";
  }

  const clipped = truncateToWidth(text, width, "…");

  return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
};

export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

/** How long the latest turn ran, or has been running; unknown for a turn a restart cut short. */
export const elapsed = (node: AgentNode, now: number): string => {
  if (node.status === "running") {
    return duration(now - node.startedAt);
  }

  return node.endedAt === undefined
    ? ""
    : duration(node.endedAt - node.startedAt);
};

const tokens = (count: number): string => {
  if (count < 1000) {
    return String(Math.round(count));
  }

  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  }

  return `${(count / 1_000_000).toFixed(1)}M`;
};

/** Input counts cached reads and writes too: all of them are context the agent sent. */
export const usageText = (usage: AgentUsage): string => {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;

  if (input === 0 && usage.output === 0) {
    return "";
  }

  const cost =
    usage.cost > 0 ? ` $${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}` : "";

  return `↑${tokens(input)} ↓${tokens(usage.output)}${cost}`;
};

export const agentName = (path: string): string =>
  path === ROOT_AGENT_PATH ? "root" : path.slice(path.lastIndexOf("/") + 1);

/** The model id without its provider, which rarely fits and rarely matters at a glance. */
export const modelText = (
  node: Pick<AgentNode, "model" | "thinking">
): string => {
  const id = node.model.slice(node.model.indexOf("/") + 1);

  return `${inlineText(id)}${node.thinking === "off" ? "" : ` · ${node.thinking}`}`;
};

export const activityText = (
  theme: Theme,
  activity: Activity | undefined
): string => {
  if (activity === undefined) {
    return theme.fg("muted", "starting");
  }

  if (activity.kind === "phase") {
    return theme.fg("muted", theme.italic(activity.label));
  }

  const target =
    activity.target === undefined ? "" : ` ${inlineText(activity.target)}`;

  return `${theme.bold(inlineText(activity.label))}${theme.fg("muted", target)}`;
};

/** What a finished agent left behind: the first line of its answer, or its error. */
export const outcomeText = (theme: Theme, node: AgentNode): string => {
  if (node.status === "errored") {
    return theme.fg("error", inlineText(node.error ?? "failed"));
  }

  if (node.status === "interrupted") {
    return theme.fg("muted", "interrupted");
  }

  const answer = node.lastAnswer
    ?.split("\n")
    .find((line) => line.trim() !== "");

  return theme.fg("muted", answer === undefined ? "done" : inlineText(answer));
};

export interface TreeRow<Item> {
  /** Undefined for the root and for ancestors the listing does not include. */
  item: Item | undefined;
  path: string;
  /** Box-drawing connectors from the root down to this row. */
  prefix: string;
}

/**
 * Lays out items depth-first under the root, siblings in input order. Ancestors of every included
 * item get a row, so each row hangs from a visible parent.
 */
export const treeRows = <Item extends { path: string }>(
  items: readonly Item[],
  include: (item: Item) => boolean = () => true
): Array<TreeRow<Item>> => {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const children = new Map<string, Set<string>>();

  for (const item of items) {
    if (!include(item)) {
      continue;
    }

    for (
      let { path } = item, parent = parentAgentPath(path);
      parent !== undefined;
      path = parent, parent = parentAgentPath(path)
    ) {
      const siblings = children.get(parent) ?? new Set();

      if (siblings.has(path)) {
        break;
      }

      siblings.add(path);
      children.set(parent, siblings);
    }
  }

  const rows: Array<TreeRow<Item>> = [
    { item: byPath.get(ROOT_AGENT_PATH), path: ROOT_AGENT_PATH, prefix: "" },
  ];

  const walk = (parent: string, indent: string) => {
    const siblings = [...(children.get(parent) ?? [])];

    for (const [index, path] of siblings.entries()) {
      const last = index === siblings.length - 1;
      rows.push({
        item: byPath.get(path),
        path,
        prefix: `${indent}${last ? "└─ " : "├─ "}`,
      });
      walk(path, `${indent}${last ? "   " : "│  "}`);
    }
  };

  walk(ROOT_AGENT_PATH, "");

  return rows;
};

export type StatusCounts = Record<AgentStatus, number>;

export const countStatuses = (nodes: readonly AgentNode[]): StatusCounts => {
  const counts: StatusCounts = {
    completed: 0,
    errored: 0,
    interrupted: 0,
    running: 0,
  };

  for (const node of nodes) {
    counts[node.status] += 1;
  }

  return counts;
};

/** "2 running · 1 done · 1 failed", spending hue only on live and failed work. */
export const countsText = (theme: Theme, counts: StatusCounts): string =>
  [
    counts.running > 0 ? theme.fg("accent", `${counts.running} running`) : "",
    counts.completed > 0 ? theme.fg("muted", `${counts.completed} done`) : "",
    counts.errored > 0 ? theme.fg("error", `${counts.errored} failed`) : "",
    counts.interrupted > 0
      ? theme.fg("muted", `${counts.interrupted} interrupted`)
      : "",
  ]
    .filter(Boolean)
    .join(theme.fg("dim", " · "));

/**
 * A titled frame top, "╭─ title ──── right ─╮", spanning exactly `width` columns. The right text
 * goes first when space runs out, then the title is cut.
 */
export const frameTop = (
  theme: Theme,
  width: number,
  title: string,
  right = ""
): string => {
  if (width < 2) {
    return " ".repeat(Math.max(0, width));
  }

  const inner = width - 2;
  const tail = right === "" ? "" : ` ${right} ─`;
  const fill = inner - 2 - visibleWidth(title) - 1 - visibleWidth(tail);

  if (fill < 1 && right !== "") {
    return frameTop(theme, width, title);
  }

  if (inner < 5) {
    return theme.fg("border", `╭${"─".repeat(inner)}╮`);
  }

  const shown = truncateToWidth(title, inner - 4, "…");
  const rest = inner - 2 - visibleWidth(shown) - 1 - visibleWidth(tail);

  return `${theme.fg("border", "╭─ ")}${shown}${theme.fg("border", ` ${"─".repeat(Math.max(1, rest))}`)}${
    right === ""
      ? ""
      : `${theme.fg("border", " ")}${right}${theme.fg("border", " ─")}`
  }${theme.fg("border", "╮")}`;
};

export const frameBottom = (
  theme: Theme,
  width: number,
  right = ""
): string => {
  if (width < 2) {
    return " ".repeat(Math.max(0, width));
  }

  const inner = width - 2;
  const tail = right === "" ? "" : ` ${right} ─`;
  const fill = inner - visibleWidth(tail);

  if (fill < 1) {
    return theme.fg("border", `╰${"─".repeat(inner)}╯`);
  }

  return `${theme.fg("border", `╰${"─".repeat(fill)}`)}${
    right === ""
      ? ""
      : `${theme.fg("border", " ")}${right}${theme.fg("border", " ─")}`
  }${theme.fg("border", "╯")}`;
};

/** A frame shorter than its two borders has no room for content. */
export const frameLine = (theme: Theme, width: number, text: string): string =>
  width < 2
    ? " ".repeat(Math.max(0, width))
    : `${theme.fg("border", "│")}${fit(text, width - 2)}${theme.fg("border", "│")}`;
