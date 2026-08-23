import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { FooterConfig } from "../config.js";
import {
  layoutFooterRows,
  renderFooterState,
  sanitizeNativeStatus,
} from "../layout.js";
import type {
  FooterRenderState,
  FooterTheme,
  RenderableWidget,
} from "../layout.js";
import type { LiveWidget } from "../widgets.js";

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

  it("renders native status ANSI without semantic theme styling", () => {
    const nativeTheme: FooterTheme = {
      bold: () => {
        throw new Error("native status must not use bold styling");
      },
      fg: (_tone, text) => {
        if (text.includes("red") || text.includes("\u001B")) {
          throw new Error("native status must not use semantic styling");
        }
        return text;
      },
    };
    const rendered = renderFooterState(
      {
        builtins: new Map(),
        config,
        nativeStatuses: new Map([["colored", "\u001B[31mred\u001B[0m"]]),
        rich: new Map(),
      },
      80,
      nativeTheme
    ).lines.join("\n");

    expect(rendered).toContain("\u001B[31mred\u001B[0m");
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

  it("strips terminal controls from rich widget text and icons", () => {
    const injected = live(
      "example.injected",
      "\u001B]52;c;secret\u0007visible",
      {
        icon: { glyphs: "\u001B[31m!" },
      }
    );
    const rendered = renderFooterState(
      {
        builtins: new Map(),
        config,
        nativeStatuses: new Map(),
        rich: new Map([[injected.snapshot.id, injected]]),
      },
      80,
      theme
    ).lines.join("\n");

    expect(rendered).toContain("visible");
    expect(rendered).not.toContain("\u001B");
  });
});
