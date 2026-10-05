import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG } from "../config.js";
import type { FooterConfig } from "../config.js";
import {
  cleanStatus,
  layoutFooter,
  renderBorder,
  renderBuiltin,
  statusWidgets,
} from "../layout.js";
import type { FooterTheme, LiveWidget } from "../layout.js";

const theme: FooterTheme = { fg: (_tone, text) => text };

const config = (rows: FooterConfig["rows"], extra: Partial<FooterConfig> = {}): FooterConfig => ({
  ...DEFAULT_CONFIG,
  border: [],
  hidden: [],
  rows,
  ...extra,
});

const live = (entries: Record<string, string | LiveWidget>): Map<string, LiveWidget> =>
  new Map(
    Object.entries(entries).map(([id, value]) => [
      id,
      typeof value === "string" ? { text: value } : value,
    ]),
  );

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

describe(layoutFooter, () => {
  it("anchors left and right groups to their edges", () => {
    const { lines } = layoutFooter(
      config([{ left: ["a", "b"], right: ["c"] }]),
      live({ a: "alpha", b: "beta", c: "gamma" }),
      24,
      theme,
    );

    expect(plain(lines)).toStrictEqual(["alpha · beta       gamma"]);
  });

  it("truncates toward the middle of the row unless a widget keeps its end", () => {
    const widgets = live({
      left: "abcdef",
      path: { text: "/a/b/c/d", truncate: "start" },
      right: "abcdef",
    });

    expect(
      plain(layoutFooter(config([{ left: ["left"], right: [] }]), widgets, 5, theme).lines),
    ).toStrictEqual(["abcd…"]);
    expect(
      plain(layoutFooter(config([{ left: [], right: ["right"] }]), widgets, 5, theme).lines),
    ).toStrictEqual(["…cdef"]);
    expect(
      plain(layoutFooter(config([{ left: ["path"], right: [] }]), widgets, 5, theme).lines),
    ).toStrictEqual(["…/c/d"]);
  });

  it("reports which widgets were truncated", () => {
    const { truncated } = layoutFooter(
      config([{ left: ["short", "long"], right: [] }]),
      live({ long: "x".repeat(40), short: "ok" }),
      20,
      theme,
    );

    expect(truncated).toStrictEqual(["long"]);
  });

  it("fits every row from 1 through 120 columns", () => {
    const widgets = live({
      a: "日本語のテキスト",
      b: "\u001B[31mred status\u001B[0m",
      c: "right side text",
    });

    for (let width = 1; width <= 120; width += 1) {
      const { lines } = layoutFooter(
        config([{ left: ["a", "b"], right: ["c"] }]),
        widgets,
        width,
        theme,
      );

      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("expands native statuses not placed elsewhere, sorted and without hidden ones", () => {
    const { lines } = layoutFooter(
      config(
        [
          { left: ["status:pinned"], right: [] },
          { left: ["footer.statuses"], right: [] },
        ],
        {
          border: ["status:vim"],
          hidden: ["status:noise"],
        },
      ),
      statusWidgets(
        new Map([
          ["zeta", "Z"],
          ["pinned", "P"],
          ["vim", "NORMAL"],
          ["noise", "N"],
          ["alpha", "A"],
          ["empty", " \n "],
        ]),
      ),
      40,
      theme,
    );

    expect(plain(lines)).toStrictEqual(["P", "A · Z"]);
  });
});

describe(renderBuiltin, () => {
  it("keeps terminal controls in session and provider text off the screen", () => {
    const widget = {
      content: [{ text: "name\u001B[2J\u0007\u202E\nnext", tone: "muted" as const }],
      id: "footer.session",
    };

    expect(renderBuiltin(widget, "ascii", theme)).toBe("name next");
  });
});

describe(cleanStatus, () => {
  it("keeps one line like Pi's footer and closes producer styling", () => {
    expect(cleanStatus(" a\nb\t c ")).toBe("a b c");
    expect(cleanStatus("\u001B[33mwarn")).toBe("\u001B[33mwarn\u001B[0m");
  });
});

describe(renderBorder, () => {
  const rule = (width: number) => "─".repeat(width);
  const border = (text: string) => text;

  it("replaces only trailing rule cells, in configured order", () => {
    const line = renderBorder(rule(30), 30, ["✉ 1", "NORMAL"], theme, border);

    expect(stripTerminalSequences(line)).toBe(`${rule(15)} ✉ 1 · NORMAL ─`);
    expect(visibleWidth(line)).toBe(30);
  });

  it("skips an entry that does not fit and keeps a later one that does", () => {
    const line = renderBorder(rule(16), 16, ["much too long", "ok"], theme, border);

    expect(stripTerminalSequences(line)).toBe(`${rule(11)} ok ─`);
  });

  it("leaves labelled or narrow borders untouched", () => {
    const labelled = `${rule(10)} ↑ 3 more ${rule(10)}`;

    expect(renderBorder(rule(4), 4, ["x"], theme, border)).toBe(rule(4));
    expect(
      renderBorder(labelled, visibleWidth(labelled), ["a much longer status"], theme, border),
    ).toBe(labelled);
  });
});
