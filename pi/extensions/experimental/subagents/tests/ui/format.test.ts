import { wireframe } from "@clanker-stuff/pi-shape-glyphs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../../tests/harness/tui.js";
import { emptyUsage } from "../../protocol.js";
import type { AgentNode } from "../../protocol.js";
import {
  BRAILLE_MARKS,
  duration,
  elapsed,
  orbMarks,
  statusMark,
  treeRows,
  usageText,
} from "../../ui/format.js";

const node = (path: string, status: AgentNode["status"] = "completed"): AgentNode => ({
  model: "provider/model",
  path,
  sessionFile: `/sessions${path}.jsonl`,
  startedAt: 0,
  status,
  thinking: "off",
  tools: [],
  usage: emptyUsage(),
});

describe(treeRows, () => {
  it("hangs agents under their parents in the order they were spawned", () => {
    const nodes = [
      node("/root/zeta"),
      node("/root/alpha"),
      node("/root/zeta/child"),
      node("/root/zeta/another"),
    ];

    expect(treeRows(nodes).map((row) => `${row.prefix}${row.path}`)).toEqual([
      "/root",
      "├─ /root/zeta",
      "│  ├─ /root/zeta/child",
      "│  └─ /root/zeta/another",
      "└─ /root/alpha",
    ]);
  });

  it("keeps the ancestors of included agents and drops everything else", () => {
    const nodes = [
      node("/root/done"),
      node("/root/parent"),
      node("/root/parent/live", "running"),
      node("/root/parent/old"),
    ];

    const rows = treeRows(nodes, (item) => item.status === "running");

    expect(rows.map((row) => row.path)).toEqual(["/root", "/root/parent", "/root/parent/live"]);
    expect(rows[1]?.item?.path).toBe("/root/parent");
  });
});

describe(orbMarks, () => {
  it("gives each top-level agent its own orb color, shared by its descendants", () => {
    const theme = createIdentityTheme();

    const marks = orbMarks(() => [
      node("/root/first"),
      node("/root/first/child"),
      node("/root/second"),
      node("/root/second/child/grandchild"),
    ]);

    const inks = (color: "cyan" | "gray" | "purple") =>
      new Set(wireframe("orb", color, "dark").frames);

    const at = (path: string) => marks.running(theme, path, 1234);

    expect(inks("cyan").has(at("/root/first"))).toBe(true);
    expect(inks("cyan").has(at("/root/first/child"))).toBe(true);
    expect(inks("purple").has(at("/root/second"))).toBe(true);
    expect(inks("purple").has(at("/root/second/child/grandchild"))).toBe(true);
    expect(inks("gray").has(at("/root"))).toBe(true);
    // The orb turns with time.
    expect(marks.running(theme, "/root/first", 0)).not.toBe(
      marks.running(theme, "/root/first", 1000),
    );
  });
});

describe(statusMark, () => {
  it("pads every mark to the running mark's width, so names line up", () => {
    const theme = createIdentityTheme("light");

    for (const marks of [BRAILLE_MARKS, orbMarks(() => [node("/root/a", "running")])])
      for (const status of ["running", "completed", "errored", "interrupted", "idle"] as const)
        expect(visibleWidth(statusMark(theme, marks, "/root/a", status, 0))).toBe(marks.width);
  });
});

describe(duration, () => {
  it.each([
    [0, "0s"],
    [59_999, "59s"],
    [60_000, "1m00s"],
    [3_599_000, "59m59s"],
    [3_600_000, "1h00m"],
    [-5, "0s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});

describe(elapsed, () => {
  it("times a running turn to now and a finished one to its end, and leaves an unknown end blank", () => {
    expect(elapsed({ ...node("/root/a", "running"), startedAt: 1000 }, 61_000)).toBe("1m00s");
    expect(elapsed({ ...node("/root/a"), endedAt: 4000, startedAt: 1000 }, 61_000)).toBe("3s");
    expect(elapsed({ ...node("/root/a", "interrupted"), startedAt: 1000 }, 61_000)).toBe("");
  });
});

describe(usageText, () => {
  it("counts cached context as input and omits zero cost", () => {
    expect(usageText(emptyUsage())).toBe("");
    expect(
      usageText({ cacheRead: 12_000, cacheWrite: 500, cost: 0, input: 300, output: 999 }),
    ).toBe("↑13k ↓999");
    expect(usageText({ cacheRead: 0, cacheWrite: 0, cost: 0.0421, input: 1500, output: 2 })).toBe(
      "↑1.5k ↓2 $0.042",
    );
  });
});
