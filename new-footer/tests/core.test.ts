import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { parseFooterConfig } from "../config.js";
import { parseGitStatus } from "../git.js";
import {
  layoutFooterRows,
  renderFooterState,
  sanitizeNativeStatus,
} from "../layout.js";
import {
  validateFooterWidgetMessage,
  validateFooterWidgetSnapshot,
} from "../protocol.js";
import type {
  FooterConfig,
  FooterRenderState,
  FooterTheme,
  LiveWidget,
  RenderableWidget,
} from "../types.js";
import { collectSessionTotals } from "../widgets.js";

const theme: FooterTheme = {
  bold: (text) => text,
  fg: (_tone, text) => text,
};

const widget = (
  id: string,
  group: RenderableWidget["group"],
  text: string,
  truncate?: RenderableWidget["truncate"]
): RenderableWidget => ({
  group,
  id,
  text,
  ...(truncate === undefined ? {} : { truncate }),
});

const live = (
  id: string,
  text: string,
  options: Partial<LiveWidget["snapshot"]> = {}
): LiveWidget => ({
  snapshot: {
    content: [{ text }],
    id,
    label: id,
    ...options,
  },
  source: id.startsWith("footer.") ? "builtin" : "rich",
});

const usage = (amount: number) => ({
  cacheRead: amount,
  cacheWrite: amount,
  cost: { total: amount / 100 },
  input: amount,
  output: amount,
});

describe("layout", () => {
  it("matches the unstyled alignment fixtures", () => {
    expect(
      layoutFooterRows(
        [[widget("alpha", "left", "alpha"), widget("beta", "right", "beta")]],
        16,
        " · "
      ).lines
    ).toStrictEqual(["alpha       beta"]);
    expect(
      layoutFooterRows([[widget("mid", "center", "mid")]], 9, " · ").lines
    ).toStrictEqual(["   mid"]);
  });

  it("truncates toward the center unless a widget overrides it", () => {
    expect(
      layoutFooterRows([[widget("left", "left", "abcdef")]], 5, " · ").lines
    ).toStrictEqual(["abcd…"]);
    expect(
      layoutFooterRows([[widget("right", "right", "abcdef")]], 5, " · ").lines
    ).toStrictEqual(["…cdef"]);
    expect(
      layoutFooterRows([[widget("center", "center", "abcdef")]], 5, " · ").lines
    ).toStrictEqual(["ab…ef"]);
    expect(
      layoutFooterRows(
        [[widget("override", "left", "abcdef", "start")]],
        5,
        " · "
      ).lines
    ).toStrictEqual(["…cdef"]);
    expect(
      layoutFooterRows(
        [
          [
            widget("left", "left", "abcdef"),
            widget("right", "right", "uvwxyz"),
          ],
        ],
        2,
        " · "
      ).lines
    ).toStrictEqual(["……"]);
  });

  it("never returns a line wider than the terminal", () => {
    const row = [
      widget("one", "left", "a very long widget"),
      widget("two", "center", "center value"),
      widget("three", "right", "right value"),
    ];
    for (let width = 1; width <= 120; width += 1) {
      for (const line of layoutFooterRows([row], width, " · ").lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("normalization", () => {
  const config: FooterConfig = {
    enabled: true,
    iconFamily: "ascii",
    rows: [
      {
        center: [],
        left: ["footer.widgets", "footer.statuses"],
        right: [],
      },
    ],
    separator: "·",
    version: 1,
    widgets: {},
  };

  it("consumes a native fallback only while its rich widget is eligible", () => {
    const rich = live("example.timer", "rich", {
      consumesStatusKeys: ["timer"],
    });
    const state: FooterRenderState = {
      builtins: new Map(),
      config,
      nativeStatuses: new Map([
        ["timer", "fallback"],
        ["voice", "voice"],
      ]),
      rich: new Map([[rich.snapshot.id, rich]]),
    };
    const result = renderFooterState(state, 80, theme);
    const rendered = result.lines.join("\n");
    expect(rendered).toContain("rich");
    expect(rendered).toContain("voice");
    expect(rendered).not.toContain("fallback");
    expect(result.consumedStatusIds).toStrictEqual(["status:timer"]);

    state.config = structuredClone(config);
    state.config.rows[0]?.left.unshift("status:timer");
    expect(renderFooterState(state, 80, theme).lines.join("\n")).toContain(
      "fallback"
    );
  });

  it("isolates a widget whose theme rendering fails", () => {
    const bad = live("example.bad", "boom");
    const good = live("example.good", "still here");
    const throwingTheme: FooterTheme = {
      bold: (text) => text,
      fg: (_tone, text) => {
        if (text === "boom") {
          throw new Error("bad widget");
        }
        return text;
      },
    };
    const result = renderFooterState(
      {
        builtins: new Map(),
        config,
        nativeStatuses: new Map(),
        rich: new Map([
          [bad.snapshot.id, bad],
          [good.snapshot.id, good],
        ]),
      },
      80,
      throwingTheme
    );

    expect(result.lines.join("\n")).toContain("still here");
    expect(result.widgetErrors).toStrictEqual([
      { id: "example.bad", message: "bad widget" },
    ]);
  });

  it("preserves only SGR controls in native statuses", () => {
    expect(
      sanitizeNativeStatus(
        "\u001B[31mred\u001B[0m\nnext\u001B]8;;https://secret\u0007link"
      )
    ).toBe("\u001B[31mred\u001B[0m nextlink\u001B[0m");
    expect(sanitizeNativeStatus("\u001B[31mred")).toBe(
      "\u001B[31mred\u001B[0m"
    );
  });

  it("ignores native statuses whose keys contain controls", () => {
    expect(
      renderFooterState(
        {
          builtins: new Map(),
          config,
          nativeStatuses: new Map([["bad\nkey", "must not render"]]),
          rich: new Map(),
        },
        80,
        theme
      ).lines.join("\n")
    ).not.toContain("must not render");
  });
});

describe("validation and collectors", () => {
  const snapshot = {
    content: [{ text: "ok", tone: "success" }],
    id: "example.widget",
    label: "Example",
  } as const;

  it("strictly validates rich snapshots and messages", () => {
    expect(validateFooterWidgetSnapshot(snapshot).ok).toBeTruthy();
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: snapshot,
      }).ok
    ).toBeTruthy();
    expect(
      validateFooterWidgetSnapshot({
        ...snapshot,
        content: [{ text: "\u001B[31munsafe" }],
      }).ok
    ).toBeFalsy();
    expect(
      validateFooterWidgetSnapshot({ ...snapshot, extra: true }).ok
    ).toBeFalsy();
  });

  it("copies validated icon glyph maps", () => {
    const glyphs = { ascii: "A" };
    const result = validateFooterWidgetSnapshot({
      ...snapshot,
      icon: { glyphs },
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    glyphs.ascii = "B";
    const { icon } = result.value;
    if (
      icon === undefined ||
      icon === false ||
      typeof icon.glyphs === "string"
    ) {
      throw new Error("expected glyph map");
    }

    expect(icon.glyphs.ascii).toBe("A");
  });

  it("validates optional truncation hints", () => {
    expect(
      validateFooterWidgetSnapshot({ ...snapshot, truncate: "middle" }).ok
    ).toBeTruthy();
    expect(
      validateFooterWidgetSnapshot({ ...snapshot, truncate: "sideways" }).ok
    ).toBeFalsy();
  });

  it("rejects unknown config fields", () => {
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        unknown: true,
        version: 1,
        widgets: {},
      })
    ).toThrow("strict object");
  });

  it("rejects control-bearing widget IDs in configuration", () => {
    const nativeId = "status:line\n\u001B[31m";
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [nativeId], right: [] }],
        separator: "·",
        version: 1,
        widgets: {},
      })
    ).toThrow("terminal controls");
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        version: 1,
        widgets: { [nativeId]: { enabled: false } },
      })
    ).toThrow("terminal controls");
  });

  it("parses porcelain-v2 Git state", () => {
    expect(
      parseGitStatus(
        [
          "# branch.head main",
          "# branch.ab +2 -1",
          "1 M. N... 100644 100644 100644 a b file",
          "1 .M N... 100644 100644 100644 a b other",
          "? untracked",
        ].join("\n")
      )
    ).toStrictEqual({
      ahead: 2,
      behind: 1,
      branch: "main",
      staged: 1,
      unstaged: 1,
      untracked: 1,
    });
  });

  it("sums usage from messages and summaries across all entries", () => {
    const context = {
      sessionManager: {
        getEntries: () => [
          {
            message: { role: "assistant", usage: usage(1) },
            type: "message",
          },
          {
            message: { role: "toolResult", usage: usage(2) },
            type: "message",
          },
          { type: "compaction", usage: usage(3) },
          { type: "branch_summary", usage: usage(4) },
        ],
        getHeader: () => ({
          timestamp: "2025-01-01T00:00:00.000Z",
        }),
        getSessionName: () => "demo",
      },
    } as never;
    expect(collectSessionTotals(context)).toStrictEqual({
      cacheRead: 10,
      cacheWrite: 10,
      cost: 0.1,
      input: 10,
      name: "demo",
      output: 10,
      startedAt: Date.parse("2025-01-01T00:00:00.000Z"),
    });
  });
});
