import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import {
  createIdentityTheme,
  createMockTui,
} from "../../../../../tests/harness/tui.js";
import { Monitor } from "../../monitor.js";
import { emptyUsage } from "../../protocol.js";
import type { AgentNode } from "../../protocol.js";
import { BRAILLE_MARKS, orbMarks } from "../../ui/format.js";
import { AgentsWidget } from "../../ui/widget.js";

const node = (path: string, fields: Partial<AgentNode>): AgentNode => ({
  model: "openai/gpt-5.6",
  path,
  sessionFile: `/sessions${path}.jsonl`,
  startedAt: 0,
  status: "completed",
  thinking: "high",
  tools: [],
  usage: emptyUsage(),
  ...fields,
});

const setup = (
  nodes: AgentNode[],
  since = 5000,
  marks = BRAILLE_MARKS,
  theme = createIdentityTheme()
) => {
  const monitor = new Monitor((cause) => {
    throw cause;
  });

  const widget = new AgentsWidget(
    createMockTui(),
    theme,
    { monitor, nodes: () => nodes, rootRunning: () => true },
    marks,
    since,
    "alt+a",
    () => 10_000
  );

  return { monitor, widget };
};

describe(AgentsWidget, () => {
  it("shows live work and this burst's outcomes, not agents that finished before it", () => {
    const { monitor, widget } = setup([
      node("/root/research", { startedAt: 4000, status: "running" }),
      node("/root/research/tests", {
        endedAt: 7000,
        lastAnswer: "All green\nmore",
      }),
      node("/root/stale", { endedAt: 1000, lastAnswer: "Old answer" }),
      node("/root/docs", {
        endedAt: 8000,
        error: "Rate limited",
        status: "errored",
      }),
    ]);

    monitor.record("/root/research", { type: "agent_start" });
    monitor.record("/root/research", {
      args: { path: "src/a.ts" },
      toolCallId: "call",
      toolName: "read",
      type: "tool_execution_start",
    });

    const lines = widget.render(100);
    const text = lines.join("\n");
    widget.dispose();

    expect(lines[0]).toMatch(
      /^╭─ agents ─+ 1 running · 1 done · 1 failed ─╮$/u
    );
    expect(lines.at(-1)).toMatch(/alt\+a inspect ─╯$/u);
    expect(text).toMatch(
      /├─ ⠋ research +gpt-5\.6 · high +read src\/a\.ts +6s/u
    );
    expect(text).toMatch(/│ {2}└─ ✓ tests .*All green +7s/u);
    expect(text).toMatch(/└─ ✗ docs .*Rate limited/u);
    expect(text).not.toContain("stale");
  });

  it("counts only this burst and says when the row limit hides live work", () => {
    // Ten agents finished long ago, each the parent of the next; the deepest one is running.
    const chain = Array.from({ length: 11 }, (_, depth) =>
      node(
        `/root${"/a".repeat(depth + 1)}`,
        depth === 10 ? { status: "running" } : { endedAt: 1000 }
      )
    );

    const { widget } = setup(chain);
    const lines = widget.render(100);
    widget.dispose();

    expect(lines[0]).toMatch(/ 1 running ─╮$/u);
    expect(lines.join("\n")).toContain("… 1 more in the viewer");
  });

  it("fits every width and drops the model column first", () => {
    const { widget } = setup([node("/root/worker", { status: "running" })]);

    for (const width of [0, 1, 2, 20, 50, 71, 72, 140]) {
      const lines = widget.render(width);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(lines.join("\n").includes("gpt-5.6")).toBe(width >= 72);
    }

    widget.dispose();
  });

  it("lines up names beside shape-spinner's two-column orbs at every width", () => {
    const nodes = [
      node("/root/alpha", { status: "running" }),
      node("/root/omega", { endedAt: 8000 }),
    ];

    const { widget } = setup(
      nodes,
      5000,
      orbMarks(() => nodes),
      createIdentityTheme()
    );

    for (const width of [0, 1, 2, 20, 50, 140]) {
      expect(
        widget.render(width).every((line) => visibleWidth(line) === width)
      ).toBe(true);
    }

    const lines = widget.render(140);

    const column = (name: string) => {
      const line = lines.find((candidate) => candidate.includes(name)) ?? "";

      return visibleWidth(line.slice(0, line.indexOf(name)));
    };

    widget.dispose();

    expect(column("alpha")).toBe(column("omega"));
  });
});
