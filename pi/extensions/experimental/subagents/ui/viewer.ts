import { readFileSync } from "node:fs";

import { inlineText, safeText } from "@clanker-stuff/pi-tool-rendering/text";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  parseSessionEntries,
  sessionEntryToContextMessages,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  ExtensionUIContext,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type {
  Component,
  Keybinding,
  KeybindingsManager,
  KeyId,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { AgentNode } from "../protocol.js";
import { agentRenderers } from "../renderers.js";
import { isCollaborationTool } from "../tools.js";
import type { ChildRuntime } from "../runtime.js";
import {
  activityText,
  agentName,
  countStatuses,
  countsText,
  elapsed,
  fit,
  frameBottom,
  frameLine,
  frameTop,
  FRAME_MS,
  modelText,
  statusMark,
  treeRows,
  usageText,
} from "./format.js";
import type { Marks, TreeRow } from "./format.js";
import { Transcript } from "./transcript.js";
import type { WidgetSource } from "./widget.js";
import type { ToolDisplay } from "./transcript.js";

/** Share of the terminal the viewer occupies; the overlay options derive from this too. */
const VIEWER_HEIGHT_RATIO = 0.9;

/** Narrowest viewer that shows the tree and transcript side by side. */
const SPLIT_MIN_WIDTH = 80;

/** Frame top, agent header, two pane rules, footer, and frame bottom. */
const CHROME_ROWS = 6;

/** The first body row, below the frame top, the agent header, and the pane rule. */
const BODY_TOP = 3;

const MIN_HEIGHT = CHROME_ROWS + 3;

const RESET = "\x1b[0m";

/** OSC and CSI sequences: the forms Pi's colours and links take, captured with the OSC body. */
const ESCAPES =
  // oxlint-disable-next-line no-control-regex -- The pattern matches terminal control sequences.
  /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/gu;

/** SGR colours (no private marker or intermediate byte), and OSC 8 links whose body holds no controls. */
const allowed = (sequence: string, osc: string | undefined): boolean =>
  osc === undefined
    ? sequence.endsWith("m") && /^[\d;:]*$/u.test(sequence.slice(2, -1))
    : osc.startsWith("8;") && safeText(osc) === osc;

/**
 * Pi's chat components draw session text as given, so controls in it would reach the terminal; Pi
 * also marks prompts as shell-integration zones, which mean nothing inside an overlay. Transcript
 * lines keep only colours and links; everything else passes through the shared sanitizer.
 */
const terminalSafe = (line: string): string => {
  let safe = "";
  let end = 0;

  for (const match of line.matchAll(ESCAPES)) {
    safe += safeText(line.slice(end, match.index)) + (allowed(match[0], match[1]) ? match[0] : "");
    end = match.index + match[0].length;
  }

  return safe + safeText(line.slice(end));
};

/**
 * Renderers learned from live children, by tool name, so a finished child's extension tools keep
 * their own display for the rest of the process.
 */
const learned = new Map<string, ToolRenderers>();

const builtIns = (cwd: string): Map<string, ToolDisplay> =>
  new Map(
    [
      createBashToolDefinition(cwd),
      createEditToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createGrepToolDefinition(cwd),
      createLsToolDefinition(cwd),
      createPowerShellToolDefinition(cwd),
      createReadToolDefinition(cwd),
      createWriteToolDefinition(cwd),
    ].map((definition): [string, ToolDisplay] => [definition.name, definition]),
  );

export interface ViewerSource extends WidgetSource {
  live: (path: string) => Pick<ChildRuntime, "snapshot" | "toolRenderers"> | undefined;
}

/** Events at which a session holds every message announced before them. */
const REREAD_EVENTS: ReadonlySet<AgentSessionEvent["type"]> = new Set([
  "agent_end",
  "agent_start",
  "turn_end",
  "turn_start",
]);

/** A stored session's current branch, read without the writes `SessionManager.open` may make. */
const readBranch = (file: string, cwd: string) => {
  const entries = parseSessionEntries(readFileSync(file, "utf-8"));

  if (entries.length === 0) throw new Error("The session file holds no session");

  return SessionManager.inMemory(cwd, undefined, entries).getBranch();
};

/** One agent's transcript and where the user left it; kept while the viewer is open. */
interface View {
  error: string | undefined;
  follow: boolean;
  /** Whether the transcript must be read again before it can follow events. */
  stale: boolean;
  /** The furthest scroll offset when this transcript was last drawn. */
  maxScroll: number;
  scroll: number;
  transcript: Transcript;
  unfollow: () => void;
}

type Focus = "transcript" | "tree";

interface Layout {
  bodyHeight: number;
  /** Columns of the transcript pane, excluding its divider; the whole inner width when not split. */
  paneWidth: number;
  split: boolean;
  tooSmall: boolean;
  treeWidth: number;
}

const layoutViewer = (width: number, height: number): Layout => {
  const inner = Math.max(0, width - 2);
  const split = width >= SPLIT_MIN_WIDTH;
  const treeWidth = split ? Math.max(24, Math.min(40, Math.floor(inner * 0.3))) : inner;

  return {
    bodyHeight: Math.max(0, height - CHROME_ROWS),
    paneWidth: split ? inner - treeWidth - 1 : inner,
    split,
    tooSmall: width < 40 || height < MIN_HEIGHT,
    treeWidth,
  };
};

const scrollbar = (theme: Theme, height: number, offset: number, total: number): string[] => {
  if (total <= height) return Array.from({ length: height }, () => " ");
  const thumb = Math.max(1, Math.round((height / total) * height));
  const start = Math.round((offset / (total - height)) * (height - thumb));

  return Array.from({ length: height }, (_, index) =>
    index >= start && index < start + thumb
      ? theme.fg("scrollbarThumb", "┃")
      : theme.fg("dim", "│"),
  );
};

/** A read-only overlay: the agent tree beside the selected agent's live transcript. */
export class AgentsViewer implements Component {
  readonly #builtIns: Map<string, ToolDisplay>;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #unsubscribe: () => void;
  readonly #views = new Map<string, View>();
  #focus: Focus = "tree";
  #layout: Layout | undefined;
  #rows: TreeRow<AgentNode>[] = [];
  #selected: string | undefined;
  #treeScroll = 0;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly source: ViewerSource;
  private readonly marks: Marks;
  private readonly cwd: string;
  private readonly done: () => void;
  private readonly now: () => number;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    source: ViewerSource,
    marks: Marks,
    cwd: string,
    done: () => void,
    now: () => number = Date.now,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.source = source;
    this.marks = marks;
    this.cwd = cwd;
    this.done = done;
    this.now = now;
    this.#builtIns = builtIns(cwd);
    this.#refreshRows();
    this.#unsubscribe = source.monitor.onChange(() => {
      this.#refreshRows();
      this.tui.requestRender();
    });
    this.#timer = setInterval(() => {
      if (
        this.source.rootRunning() ||
        this.source.nodes().some((node) => node.status === "running")
      )
        this.tui.requestRender();
    }, FRAME_MS);
  }

  #refreshRows(): void {
    this.#rows = treeRows(this.source.nodes());

    // Select the first running agent, else the latest, once there is one and when a replaced tree
    // no longer holds the selection.
    if (this.#selected === undefined || !this.#rows.some((row) => row.path === this.#selected)) {
      const nodes = this.#rows.flatMap((row) => (row.item === undefined ? [] : [row.item]));
      this.#select(nodes.find((node) => node.status === "running")?.path ?? nodes.at(-1)?.path);
    }
  }

  #renderers(agent: string, name: string): ToolDisplay {
    const live = this.source.live(agent)?.toolRenderers(name);

    if (live !== undefined) learned.set(name, live);

    if (isCollaborationTool(name)) return agentRenderers(name);

    return live ?? learned.get(name) ?? this.#builtIns.get(name);
  }

  #select(target: string | undefined): void {
    this.#selected = target;
    const node = this.#node();

    if (node !== undefined && !this.#views.has(node.path))
      this.#views.set(node.path, this.#open(node));
  }

  #open(node: AgentNode): View {
    const transcript = new Transcript({
      cwd: this.cwd,
      renderers: (name) => this.#renderers(node.path, name),
      theme: this.theme,
      tui: this.tui,
    });

    const view: View = {
      error: undefined,
      follow: true,
      maxScroll: 0,
      scroll: 0,
      stale: false,
      transcript,
      unfollow: () => {},
    };

    const fail = (error: unknown) => {
      view.error = error instanceof Error ? error.message : String(error);
      view.stale = true;
    };

    const live = this.source.live(node.path);

    // A spawn is announced before its session runs or is written; it is read once it starts.
    if (live === undefined && node.status === "running") view.stale = true;
    else
      try {
        const snapshot = live?.snapshot();
        const branch = snapshot?.branch ?? readBranch(node.sessionFile, this.cwd);
        // Unlike the model's context, the transcript keeps history that compaction summarized.
        transcript.load(
          branch.flatMap(sessionEntryToContextMessages),
          snapshot?.streaming,
          snapshot?.executing,
        );
      } catch (error) {
        fail(error);
      }

    // Events follow the path, so the transcript continues across the agent's later turns.
    view.unfollow = this.source.monitor.follow(node.path, (event) => {
      if (!view.stale) {
        try {
          transcript.handle(event);
        } catch (error) {
          fail(error);
        }
      } else if (REREAD_EVENTS.has(event.type)) {
        // Pi records a message after announcing it, so only a turn boundary finds the session
        // whole; until then the pane shows what failed.
        view.unfollow();
        transcript.dispose();
        this.#views.set(node.path, this.#open(node));
      }

      this.tui.requestRender();
    });

    return view;
  }

  #view(): View | undefined {
    return this.#selected === undefined ? undefined : this.#views.get(this.#selected);
  }

  #node(): AgentNode | undefined {
    return this.#rows.find((row) => row.path === this.#selected)?.item;
  }

  #move(delta: number): void {
    const selectable = this.#rows.filter((row) => row.item !== undefined);
    const index = selectable.findIndex((row) => row.path === this.#selected);
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, index + delta))];

    if (next !== undefined) this.#select(next.path);
  }

  #scrollBy(delta: number): void {
    const view = this.#view();

    if (view === undefined) return;
    view.scroll = Math.max(0, Math.min(view.maxScroll, view.scroll + delta));
    view.follow = view.scroll >= view.maxScroll;
  }

  #back(): void {
    if (this.#focus === "transcript") this.#focus = "tree";
    else this.done();
  }

  handleInput(data: string): void {
    const key = (id: KeyId) => matchesKey(data, id);
    const action = (id: Keybinding) => this.keybindings.matches(data, id);
    const page = Math.max(1, (this.#layout?.bodyHeight ?? 1) - 1);
    const inTranscript = this.#focus === "transcript";
    const vertical = (delta: number) => (inTranscript ? this.#scrollBy(delta) : this.#move(delta));

    // First matching binding wins; configured Pi actions come before fixed keys and vim aliases.
    const bindings: Array<[boolean, () => void]> = [
      [action("tui.select.cancel"), () => this.#back()],
      [
        action("tui.select.confirm") || key(Key.tab),
        () => {
          this.#focus = inTranscript ? "tree" : "transcript";
        },
      ],
      [action("tui.select.pageDown"), () => this.#scrollBy(page)],
      [action("tui.select.pageUp"), () => this.#scrollBy(-page)],
      [action("tui.select.down") || key("j"), () => vertical(1)],
      [action("tui.select.up") || key("k"), () => vertical(-1)],
      [
        key("f"),
        () => {
          const view = this.#view();

          if (view !== undefined) view.follow = !view.follow;
        },
      ],
      [
        key("e") || action("app.tools.expand"),
        () => {
          const transcript = this.#view()?.transcript;
          transcript?.setExpanded(!transcript.expanded);
        },
      ],
    ];

    bindings.find(([matched]) => matched)?.[1]();
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const layout = this.#layout;

    if (layout === undefined) return { handled: true };
    const row = event.y - BODY_TOP;
    const inTranscript = !layout.split ? this.#focus === "transcript" : event.x > layout.treeWidth;

    if (event.type === "wheel") {
      if (inTranscript) this.#scrollBy(event.wheelDelta ?? 0);
      else this.#move(event.wheelDelta ?? 0);
    } else if (
      event.type === "press" &&
      event.button === "left" &&
      row >= 0 &&
      row < layout.bodyHeight
    ) {
      if (inTranscript) this.#focus = "transcript";
      else {
        this.#focus = "tree";
        const target = this.#rows[this.#treeScroll + row];

        if (target?.item !== undefined) this.#select(target.path);
      }
    } else {
      return undefined;
    }

    this.tui.requestRender();

    return { handled: true, focus: true };
  }

  #treeLines(width: number, height: number, now: number): string[] {
    const { theme } = this;
    const selectedIndex = this.#rows.findIndex((row) => row.path === this.#selected);

    // Keep the selection in view.
    if (selectedIndex < this.#treeScroll) this.#treeScroll = selectedIndex;
    else if (selectedIndex >= this.#treeScroll + height)
      this.#treeScroll = selectedIndex - height + 1;
    this.#treeScroll = Math.max(0, Math.min(this.#treeScroll, this.#rows.length - height));
    const focused = this.#focus === "tree";

    return this.#rows.slice(this.#treeScroll, this.#treeScroll + height).map((row) => {
      const node = row.item;
      const selected = row.path === this.#selected;

      const glyph = statusMark(
        theme,
        this.marks,
        row.path,
        node?.status ?? (this.source.rootRunning() ? "running" : "idle"),
        now,
      );

      const name = node === undefined ? "root" : agentName(row.path);
      const time = node === undefined ? "" : theme.fg("muted", elapsed(node, now));
      const timeWidth = visibleWidth(time);
      const marker = selected ? theme.fg(focused ? "accent" : "muted", "▌") : " ";

      const label = `${marker}${theme.fg("dim", row.prefix)}${glyph} ${
        selected || node?.status === "running" ? theme.bold(name) : name
      }`;

      const line = `${fit(label, width - timeWidth - 2)} ${time} `;

      // Truncation ends its text with full resets, which would also end the highlight.
      return selected
        ? line
            .split(RESET)
            .map((part) => theme.bg("selectedBg", part))
            .join(RESET)
        : line;
    });
  }

  #transcriptLines(width: number, height: number): string[] {
    const { theme } = this;
    const contentWidth = Math.max(1, width - 2);
    const view = this.#view();

    if (view?.error !== undefined)
      return [
        fit(` ${theme.fg("error", inlineText(view.error))}`, width),
        ...Array.from({ length: height - 1 }, () => " ".repeat(width)),
      ];

    const lines = view?.transcript.render(contentWidth) ?? [];

    if (view === undefined || lines.length === 0)
      return [
        fit(
          ` ${theme.fg("muted", this.#selected === undefined ? "No subagents in this session yet." : "No activity yet.")}`,
          width,
        ),
        ...Array.from({ length: height - 1 }, () => " ".repeat(width)),
      ];

    view.maxScroll = Math.max(0, lines.length - height);
    view.scroll = view.follow ? view.maxScroll : Math.min(view.scroll, view.maxScroll);
    const bar = scrollbar(theme, height, view.scroll, lines.length);

    return Array.from(
      { length: height },
      (_, index) =>
        `${fit(` ${terminalSafe(lines[view.scroll + index] ?? "")}`, width - 1)}${bar[index] ?? " "}`,
    );
  }

  #header(width: number, now: number): string {
    const { theme } = this;
    const node = this.#node();

    if (node === undefined) return "";
    const sep = theme.fg("dim", " · ");

    const left = [
      `${statusMark(theme, this.marks, node.path, node.status, now)} ${theme.bold(agentName(node.path))}`,
      theme.fg("muted", inlineText(node.path)),
      node.status === "running" ? activityText(theme, this.source.monitor.activity(node.path)) : "",
    ]
      .filter(Boolean)
      .join(sep);

    const right = [
      theme.fg("muted", modelText(node)),
      theme.fg("muted", elapsed(node, now)),
      theme.fg("muted", usageText(node.usage)),
    ]
      .filter((part) => visibleWidth(part) > 0)
      .join(sep);

    const gap = width - visibleWidth(left) - visibleWidth(right);

    return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : fit(left, width);
  }

  #footer(width: number): string {
    const { theme } = this;
    const inTranscript = this.#focus === "transcript";
    const view = this.#view();

    const hints: [key: string, label: string][] = [
      ["↑↓", inTranscript ? "scroll" : "select"],
      ["tab", inTranscript ? "tree" : "transcript"],
      ["f", view?.follow === false ? "follow" : "following"],
      ["e", view?.transcript.expanded === true ? "collapse" : "expand"],
      ["esc", inTranscript ? "back" : "close"],
    ];

    // Key hints are chrome the user reads past (docs/color.md); bold picks out the key.
    const keys = hints
      .map(([key, label]) => `${theme.bold(theme.fg("dim", key))} ${theme.fg("dim", label)}`)
      .join(theme.fg("dim", " · "));

    const position =
      view !== undefined && view.maxScroll > 0 && !view.follow
        ? theme.fg("muted", `${Math.round((view.scroll / view.maxScroll) * 100)}%`)
        : "";

    const gap = width - visibleWidth(keys) - visibleWidth(position);

    return gap >= 1 ? `${keys}${" ".repeat(gap)}${position}` : fit(keys, width);
  }

  render(width: number): string[] {
    const { theme } = this;
    const now = this.now();
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * VIEWER_HEIGHT_RATIO));
    const layout = layoutViewer(width, height);
    this.#layout = layout;

    if (layout.tooSmall) return [fit(theme.fg("muted", "/agents: enlarge the terminal"), width)];
    const inner = width - 2;
    const border = (text: string) => theme.fg("border", text);
    const divider = theme.fg(this.#focus === "transcript" ? "borderAccent" : "borderMuted", "│");

    const rule = (left: string, junction: string, right: string) =>
      layout.split
        ? `${border(left)}${border("─".repeat(layout.treeWidth))}${theme.fg(this.#focus === "transcript" ? "borderAccent" : "borderMuted", junction)}${border("─".repeat(layout.paneWidth))}${border(right)}`
        : border(`${left}${"─".repeat(inner)}${right}`);

    let body: string[];

    if (layout.split) {
      const tree = this.#treeLines(layout.treeWidth, layout.bodyHeight, now);
      const transcript = this.#transcriptLines(layout.paneWidth, layout.bodyHeight);
      body = Array.from(
        { length: layout.bodyHeight },
        (_, index) =>
          `${border("│")}${fit(tree[index] ?? "", layout.treeWidth)}${divider}${transcript[index] ?? ""}${border("│")}`,
      );
    } else {
      const pane =
        this.#focus === "transcript"
          ? this.#transcriptLines(inner, layout.bodyHeight)
          : this.#treeLines(inner, layout.bodyHeight, now);

      body = Array.from(
        { length: layout.bodyHeight },
        (_, index) => `${border("│")}${fit(pane[index] ?? "", inner)}${border("│")}`,
      );
    }

    const nodes = this.source.nodes();

    return [
      frameTop(
        theme,
        width,
        `${theme.bold(theme.fg("accent", "agents"))}${theme.fg("dim", " · ")}${theme.fg("muted", `${nodes.length} in this session`)}`,
        countsText(theme, countStatuses(nodes)),
      ),
      frameLine(theme, width, ` ${this.#header(inner - 2, now)}`),
      rule("├", "┬", "┤"),
      ...body,
      rule("├", "┴", "┤"),
      frameLine(theme, width, ` ${this.#footer(inner - 2)}`),
      frameBottom(theme, width),
    ];
  }

  invalidate(): void {
    for (const view of this.#views.values()) view.transcript.invalidate();
  }

  dispose(): void {
    clearInterval(this.#timer);
    this.#unsubscribe();

    for (const view of this.#views.values()) {
      view.unfollow();
      view.transcript.dispose();
    }
  }
}

/** Shows the overlay until the user closes it. */
export const openViewer = async (
  ui: Pick<ExtensionUIContext, "custom">,
  source: ViewerSource,
  marks: Marks,
  cwd: string,
): Promise<void> => {
  await ui.custom<undefined>(
    (tui, theme, keybindings, done) =>
      new AgentsViewer(tui, theme, keybindings, source, marks, cwd, () => done(undefined)),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        maxHeight: `${VIEWER_HEIGHT_RATIO * 100}%`,
        width: "94%",
      },
    },
  );
};
