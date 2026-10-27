import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  createIdentityTheme,
  createMockTui,
} from "../../../../../tests/harness/tui.js";
import { Monitor } from "../../monitor.js";
import { emptyUsage, envelopeText } from "../../protocol.js";
import type { AgentNode } from "../../protocol.js";
import type { ChildRuntime } from "../../runtime.js";
import { BRAILLE_MARKS } from "../../ui/format.js";
import { AgentsViewer } from "../../ui/viewer.js";

type HistoryMessage = Parameters<SessionManager["appendMessage"]>[0];

const assistant = (
  text: string
): Extract<HistoryMessage, { role: "assistant" }> => ({
  api: "faux",
  content: [{ text, type: "text" }],
  model: "child",
  provider: "provider",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const task = (to: string, content: string): HistoryMessage => ({
  content: envelopeText({ content, from: "/root", kind: "NEW_TASK", to }),
  role: "user",
  timestamp: 0,
});

const node = (agentPath: string, fields: Partial<AgentNode>): AgentNode => ({
  model: "provider/child",
  path: agentPath,
  sessionFile: "/missing.jsonl",
  startedAt: 0,
  status: "completed",
  thinking: "off",
  tools: [],
  usage: emptyUsage(),
  ...fields,
});

const press = (x: number, y: number): TuiMouseEvent => ({
  alt: false,
  button: "left",
  ctrl: false,
  height: 36,
  screenX: x,
  screenY: y,
  shift: false,
  type: "press",
  width: 120,
  x,
  y,
});

const messageStart = (content: string) => ({
  message: { content, role: "user" as const, timestamp: 0 },
  type: "message_start" as const,
});

describe(AgentsViewer, () => {
  let dir: string;

  beforeAll(() => {
    initTheme("dark");
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "subagents-viewer-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const setup = (
    extra: AgentNode[] = [],
    liveText = "Looking into it",
    theme = createIdentityTheme()
  ) => {
    // A finished agent is read from its session file.
    const stored = SessionManager.create(dir, dir);
    stored.appendMessage(task("/root/done", "Summarize the docs"));
    stored.appendMessage(assistant("Stored final answer"));

    // A running agent is read from its live session, then followed through events.
    const live = SessionManager.inMemory(dir);
    live.appendMessage(task("/root/worker", "Investigate the flaky test"));
    live.appendMessage(assistant(liveText));

    const runtime: Pick<ChildRuntime, "snapshot" | "toolRenderers"> = {
      snapshot: () => ({
        branch: live.getBranch(),
        executing: new Set<string>(),
        streaming: undefined,
      }),
      toolRenderers: (): undefined => undefined,
    };

    const monitor = new Monitor((cause) => {
      throw cause;
    });

    const lives = new Map([["/root/worker", runtime]]);

    const nodes = [
      node("/root/done", {
        endedAt: 3000,
        sessionFile: stored.getSessionFile() ?? "",
      }),
      node("/root/worker", { startedAt: 1000, status: "running" }),
      ...extra,
    ];

    const done = vi.fn<() => void>();

    const viewer = new AgentsViewer(
      createMockTui({ rows: 40 }),
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      {
        live: (agent) => lives.get(agent),
        monitor,
        nodes: () => nodes,
        rootRunning: () => false,
      },
      BRAILLE_MARKS,
      dir,
      done,
      () => 5000
    );

    const render = (width = 120) => viewer.render(width).join("\n");

    return { done, lives, monitor, render, runtime, viewer };
  };

  it("opens on the running agent and draws its task without the mail envelope", () => {
    const { render, viewer } = setup();
    const text = render();
    viewer.dispose();

    expect(text).toContain("⠋ worker · /root/worker");
    expect(text).toContain("task from root");
    expect(text).toContain("Investigate the flaky test");
    expect(text).toContain("Looking into it");
    expect(text).not.toContain("Message Type:");
  });

  it("follows live events of the selected agent into its transcript", () => {
    const { monitor, render, viewer } = setup();
    render();
    // Only the transcript draws messages; the header shows activity, never message text.
    monitor.record("/root/worker", {
      message: {
        content: "Also check the CI logs",
        role: "user",
        timestamp: 0,
      },
      type: "message_start",
    });
    const text = render();
    viewer.dispose();

    expect(text).toContain("Also check the CI logs");
  });

  it("keeps terminal controls in session text from reaching the terminal", () => {
    const { render, viewer } = setup(
      [],
      "before\u001B]52;c;SGVsbG8=\u0007after \u202Eevil \u001B[2Jdone \u001B]8;;https://x/\u202E\u009B2J\u0007link\u001B]8;;\u0007 keys\u001B[>4;2m\u001B[?4m"
    );

    const text = render();
    viewer.dispose();

    expect(text).toContain("beforeafter");
    expect(text).toContain("evil done");
    expect(text).not.toContain("\u001B]52");
    expect(text).not.toContain("\u202E");
    expect(text).not.toContain("\u001B[2J");
    // Controls inside a link's target do not ride through with the link.
    expect(text).not.toContain("\u009B");
    expect(text).toContain("link");
    // Keyboard-mode commands end in `m` like colours do.
    expect(text).not.toContain("\u001B[>4;2m");
    expect(text).not.toContain("\u001B[?4m");
  });

  it("reports unreadable sessions without writing to them", async () => {
    const empty = path.join(dir, "empty.jsonl");
    await writeFile(empty, "");

    const { render, viewer } = setup([
      node("/root/empty", { endedAt: 3000, sessionFile: empty }),
      node("/root/missing", {
        endedAt: 3000,
        sessionFile: path.join(dir, "missing.jsonl"),
      }),
    ]);

    // Down.
    viewer.handleInput("\u001B[B");
    expect(render()).toContain("holds no session");
    viewer.handleInput("\u001B[B");
    expect(render()).toContain("ENOENT");
    viewer.dispose();

    const { size } = await stat(empty);
    expect(size).toBe(0);
    await expect(readFile(empty, "utf-8")).resolves.toBe("");
  });

  it("retries an unreadable agent once it is active again", () => {
    const { lives, monitor, render, runtime, viewer } = setup([
      node("/root/missing", {
        endedAt: 3000,
        sessionFile: path.join(dir, "missing.jsonl"),
      }),
    ]);

    // Down.
    viewer.handleInput("\u001B[B");
    expect(render()).toContain("ENOENT");

    // A follow-up gives the agent a live session again.
    lives.set("/root/missing", runtime);
    monitor.record("/root/missing", { type: "agent_start" });
    const text = render();
    viewer.dispose();

    expect(text).not.toContain("ENOENT");
    expect(text).toContain("Looking into it");
  });

  it("re-reads an agent at its next turn boundary after a drawing failure, settling old rows", () => {
    vi.useFakeTimers();

    try {
      const theme = createIdentityTheme();
      const fg = theme.fg.bind(theme);
      let broken = false;

      theme.fg = (color, text) => {
        if (broken) {
          throw new Error("theme broke");
        }

        return fg(color, text);
      };

      const { monitor, render, viewer } = setup([], undefined, theme);
      render();

      // A running shell row redraws every second until it settles.
      const args = { command: "sleep 9" };
      monitor.record("/root/worker", {
        args,
        toolCallId: "b1",
        toolName: "bash",
        type: "tool_execution_start",
      });
      monitor.record("/root/worker", {
        args,
        partialResult: { content: [{ text: "partial", type: "text" }] },
        toolCallId: "b1",
        toolName: "bash",
        type: "tool_execution_update",
      });

      broken = true;
      monitor.record(
        "/root/worker",
        messageStart(
          envelopeText({
            content: "More",
            from: "/root",
            kind: "MESSAGE",
            to: "/root/worker",
          })
        )
      );
      broken = false;
      expect(render()).toContain("theme broke");

      // Mid-turn, the session may not hold every message drawn so far.
      monitor.record("/root/worker", messageStart("Not yet"));
      expect(render()).toContain("theme broke");

      monitor.record("/root/worker", { type: "turn_start" });
      const text = render();
      viewer.dispose();

      expect(text).not.toContain("theme broke");
      expect(text).toContain("Looking into it");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects agents by clicking tree rows and ignores clicks below the tree body", () => {
    // More agents than the 30 body rows of a 40-row terminal, so rows exist below the body.
    const extra = Array.from({ length: 40 }, (_, index) =>
      node(`/root/extra_${index}`, { endedAt: 3000 })
    );

    const { render, viewer } = setup(extra);
    render();
    // The footer row, inside the tree column.
    viewer.handleMouse(press(5, 34));
    expect(render()).toContain("⠋ worker · /root/worker");

    // The body's second row: the first agent under root.
    viewer.handleMouse(press(5, 4));
    const text = render();
    viewer.dispose();

    expect(text).toContain("✓ done · /root/done");
  });

  it("keeps the selection highlight across a truncated name", () => {
    const theme = createIdentityTheme();
    const highlight = "\u001B[48;5;4m";
    theme.bg = (_color, text) => `${highlight}${text}\u001B[49m`;

    const { render, viewer } = setup(
      [node(`/root/${"long_name_".repeat(6)}`, { endedAt: 3000 })],
      undefined,
      theme
    );

    // Down, to the long name.
    viewer.handleInput("\u001B[B");

    const row = render()
      .split("\n")
      .find((line) => line.includes(highlight) && line.includes("long_name_"));

    viewer.dispose();

    expect(row).toContain("…");
    // Every reset that truncation adds is followed by the highlight again.
    expect(
      row
        ?.split("\u001B[0m")
        .slice(1)
        .every((part) => part.startsWith(highlight))
    ).toBe(true);
  });

  it("selects the first agent spawned after it opened on an empty tree", () => {
    const nodes: AgentNode[] = [];

    const monitor = new Monitor((cause) => {
      throw cause;
    });

    const viewer = new AgentsViewer(
      createMockTui({ rows: 40 }),
      createIdentityTheme(),
      new KeybindingsManager(TUI_KEYBINDINGS),
      {
        live: (): undefined => undefined,
        monitor,
        nodes: () => nodes,
        rootRunning: () => true,
      },
      BRAILLE_MARKS,
      dir,
      () => {},
      () => 5000
    );

    expect(viewer.render(120).join("\n")).toContain(
      "No subagents in this session yet."
    );

    nodes.push(node("/root/late", { startedAt: 1000, status: "running" }));
    monitor.changed();
    const text = viewer.render(120).join("\n");
    viewer.dispose();

    expect(text).toContain("⠋ late · /root/late");
    // Its session is neither running nor written yet.
    expect(text).not.toContain("ENOENT");
  });

  it("reads a finished agent's transcript from its session file", () => {
    const { render, viewer } = setup();
    // Up.
    viewer.handleInput("\u001B[A");
    const text = render();
    viewer.dispose();

    expect(text).toContain("✓ done · /root/done");
    expect(text).toContain("Summarize the docs");
    expect(text).toContain("Stored final answer");
  });

  it("draws a finished agent's collaboration calls with the subagent cards", () => {
    const stored = SessionManager.create(dir, dir);
    stored.appendMessage(task("/root/lead", "Split the work"));
    stored.appendMessage({
      ...assistant(""),
      content: [
        {
          arguments: { message: "Check docs", task_name: "docs" },
          id: "c1",
          name: "spawn_agent",
          type: "toolCall",
        },
      ],
      stopReason: "toolUse",
    });
    stored.appendMessage({
      content: [
        {
          text: JSON.stringify({ task_name: "/root/lead/docs" }),
          type: "text",
        },
      ],
      isError: false,
      role: "toolResult",
      timestamp: 0,
      toolCallId: "c1",
      toolName: "spawn_agent",
    });

    // No live session is left to ask for its renderers.
    const { render, viewer } = setup([
      node("/root/lead", {
        endedAt: 3000,
        sessionFile: stored.getSessionFile() ?? "",
      }),
    ]);

    // Down, to the lead.
    viewer.handleInput("\u001B[B");
    const text = stripVTControlCharacters(render());
    viewer.dispose();

    expect(text).toContain("✓ Spawned /root/lead/docs");
  });

  it("unwinds focus before closing and fits narrow terminals", () => {
    const { done, render, viewer } = setup();

    viewer.handleInput("\t");
    viewer.handleInput("\u001B");
    expect(done).not.toHaveBeenCalled();
    viewer.handleInput("\u001B");
    expect(done).toHaveBeenCalledOnce();

    for (const width of [40, 79, 80, 160]) {
      expect(
        render(width)
          .split("\n")
          .every((line) => visibleWidth(line) === width)
      ).toBe(true);
    }

    viewer.dispose();
  });
});
