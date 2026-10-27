import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { Monitor } from "../monitor.js";
import type { AgentNode } from "../protocol.js";
import {
  activityText,
  agentName,
  countStatuses,
  countsText,
  elapsed,
  fit,
  fitRight,
  frameBottom,
  frameLine,
  frameTop,
  FRAME_MS,
  modelText,
  outcomeText,
  statusMark,
  treeRows,
} from "./format.js";
import type { Marks, TreeRow } from "./format.js";

/** Rows of agents the widget lists before it summarizes the rest. */
const MAX_ROWS = 10;

/** The model column is the first to go when the widget gets narrow. */
const MODEL_MIN_WIDTH = 72;

const NAME_MAX_WIDTH = 32;

const MODEL_MAX_WIDTH = 28;

const TIME_WIDTH = 7;

export interface WidgetSource {
  readonly monitor: Monitor;
  nodes: () => readonly AgentNode[];
  rootRunning: () => boolean;
}

/**
 * A live tree of the agents taking part in the current burst of work: those running, those that
 * finished since the widget appeared, and their ancestors.
 */
export class AgentsWidget implements Component {
  readonly #timer: ReturnType<typeof setInterval>;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly source: WidgetSource;
  private readonly marks: Marks;
  /** When the widget appeared; agents that finished earlier are not part of this burst. */
  private readonly since: number;
  private readonly hint: string;
  private readonly now: () => number;

  constructor(
    tui: TUI,
    theme: Theme,
    source: WidgetSource,
    marks: Marks,
    since: number,
    hint: string,
    now: () => number = Date.now
  ) {
    this.tui = tui;
    this.theme = theme;
    this.source = source;
    this.marks = marks;
    this.since = since;
    this.hint = hint;
    this.now = now;
    this.#timer = setInterval(() => {
      this.tui.requestRender();
    }, FRAME_MS);
  }

  /** The rows to draw, and the agents of this burst: drawn ones and those the limit left out. */
  #layout() {
    const nodes = this.source.nodes();

    const inBurst = (node: AgentNode) =>
      node.status === "running" || (node.endedAt ?? 0) >= this.since;

    const burst = nodes.filter(inBurst);
    let rows = treeRows(nodes, inBurst);

    // Past the limit, keep live work and the branches it hangs from.
    if (rows.length > MAX_ROWS + 1) {
      rows = treeRows(nodes, (node) => node.status === "running");
    }

    rows = rows.slice(0, MAX_ROWS + 1);
    const drawn = new Set(rows.map((row) => row.item));

    return {
      burst,
      hidden: burst.filter((node) => !drawn.has(node)).length,
      rows,
    };
  }

  render(width: number): string[] {
    const { theme } = this;
    const now = this.now();
    const inner = Math.max(0, width - 4);
    const { burst, hidden, rows } = this.#layout();

    const nodes = rows.flatMap((row) =>
      row.item === undefined ? [] : [row.item]
    );

    const showModel = width >= MODEL_MIN_WIDTH;

    const label = (row: TreeRow<AgentNode>) =>
      `${theme.fg("dim", row.prefix)}${
        row.item === undefined
          ? `${statusMark(theme, this.marks, row.path, this.source.rootRunning() ? "running" : "idle", now)} ${theme.bold("root")}`
          : `${statusMark(theme, this.marks, row.path, row.item.status, now)} ${row.item.status === "running" ? theme.bold(agentName(row.path)) : agentName(row.path)}`
      }`;

    const named = rows.map((row) => ({ name: label(row), row }));

    const nameWidth = Math.min(
      NAME_MAX_WIDTH,
      Math.max(...named.map(({ name }) => visibleWidth(name)))
    );

    const modelWidth = showModel
      ? Math.min(
          MODEL_MAX_WIDTH,
          Math.max(0, ...nodes.map((node) => modelText(node).length))
        )
      : 0;

    const activityWidth = Math.max(
      0,
      inner -
        nameWidth -
        2 -
        (modelWidth > 0 ? modelWidth + 2 : 0) -
        TIME_WIDTH -
        1
    );

    const line = ({
      name,
      row,
    }: {
      name: string;
      row: TreeRow<AgentNode>;
    }): string => {
      const node = row.item;

      if (node === undefined) {
        return name;
      }

      return [
        fit(name, nameWidth),
        "  ",
        modelWidth > 0
          ? `${fit(theme.fg("muted", modelText(node)), modelWidth)}  `
          : "",
        fit(
          node.status === "running"
            ? activityText(theme, this.source.monitor.activity(node.path))
            : outcomeText(theme, node),
          activityWidth
        ),
        " ",
        fitRight(theme.fg("muted", elapsed(node, now)), TIME_WIDTH),
      ].join("");
    };

    const body = named.map((row) => frameLine(theme, width, ` ${line(row)}`));

    if (hidden > 0) {
      body.push(
        frameLine(
          theme,
          width,
          ` ${theme.fg("muted", `… ${hidden} more in the viewer`)}`
        )
      );
    }

    return [
      frameTop(
        theme,
        width,
        theme.bold("agents"),
        countsText(theme, countStatuses(burst))
      ),
      ...body,
      frameBottom(
        theme,
        width,
        `${theme.bold(theme.fg("dim", this.hint))} ${theme.fg("dim", "inspect")}`
      ),
    ];
  }

  invalidate(): void {
    // Every render reads live state and the current theme.
  }

  dispose(): void {
    clearInterval(this.#timer);
  }
}
