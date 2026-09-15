import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import {
  distributeCells,
  layoutOverlay,
  renderOverlay,
  renderUsageBar,
  usageSegments,
} from "../render.js";
import { fixturePart, fixtureSnapshot } from "./fixtures/snapshot.js";

const theme = createIdentityTheme();
const segments = usageSegments(
  fixtureSnapshot({
    prompt: "x".repeat(40),
    usage: { tokens: 40, contextWindow: 64, percent: 62.5 },
  }),
);

describe("render", () => {
  it.each([0, 1, 2, 10, 66, 100])(
    "bounds the usage bar to %s columns, including overflow",
    (width) => {
      for (const tokens of [0, 2, 48, 64, 1000]) {
        expect(
          visibleWidth(
            renderUsageBar(theme, { tokens, contextWindow: 64, percent: 0 }, segments, width),
          ),
        ).toBe(width);
      }
      expect(
        renderUsageBar(theme, { tokens: null, contextWindow: 64, percent: null }, segments, width),
      ).toBe("░".repeat(width));
      expect(renderUsageBar(theme, undefined, segments, width)).toBe("░".repeat(width));
    },
  );
  it("fills every accepted size exactly and clips sizes below the minimum", () => {
    const body = ["BODY".repeat(100)];
    const footer = "HELP".repeat(100);
    for (let width = 5; width <= 30; width += 1) {
      for (const height of [10, 13, 14, 19, 20, 24]) {
        const lines = renderOverlay(
          theme,
          fixtureSnapshot(),
          layoutOverlay(width, height, false),
          body,
          footer,
        );
        expect(lines, `${width}x${height}`).toHaveLength(height);
        expect(
          lines.every((line) => visibleWidth(line) === width),
          `${width}x${height}`,
        ).toBe(true);
      }
    }
    for (const [width, height] of [
      [4, 24],
      [120, 9],
      [1, 1],
    ]) {
      const lines = renderOverlay(
        theme,
        fixtureSnapshot(),
        layoutOverlay(width, height, false),
        body,
        footer,
      );
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
    }
  });
  it("draws a titled frame with a stacked usage bar, legend and joined pane divider", () => {
    const snapshot = fixtureSnapshot({
      prompt: "x".repeat(400),
      tools: [],
      usage: { tokens: 400, contextWindow: 1000, percent: 40 },
    });
    const withParts = {
      ...snapshot,
      tools: [fixturePart("read", "{}", 200)],
      messages: [fixturePart("1. user", "hi", 100)],
    };
    const layout = layoutOverlay(120, 24, false);
    const lines = renderOverlay(theme, withParts, layout, ["System prompt"], "help");
    expect(lines[0]).toMatch(/^╭─ \/context · test\/model ─+╮$/);
    expect(lines[1]).toBe(`│${" ".repeat(118)}│`);
    expect(lines[2]).toContain("400 / 1,000 tokens · 40.0% used · 600 free");
    expect(lines[3]).toBe(`│  ${"█".repeat(46)}${"░".repeat(68)}  │`);
    expect(lines[4]).toContain(
      "■ system ~100 · 25%   ■ tools ~200 · 50%   ■ messages ~100 · 25%   ░ free 600",
    );
    expect(lines[5]).toBe(`│${" ".repeat(118)}│`);
    expect(lines[6]).toBe(`├${"─".repeat(layout.treeWidth)}┬${"─".repeat(layout.previewWidth)}┤`);
    expect(lines[7]).toBe(`│${" ".repeat(layout.treeWidth)}│${" ".repeat(layout.previewWidth)}│`);
    expect(lines[8]).toContain("System prompt");
    expect(lines.at(-3)).toBe(
      `├${"─".repeat(layout.treeWidth)}┴${"─".repeat(layout.previewWidth)}┤`,
    );
    expect(lines.at(-2)).toBe(`│  help${" ".repeat(112)}│`);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => visibleWidth(line) === 120)).toBe(true);
  });

  it.each([
    [[1, 1, 1], 0, [0, 0, 0]],
    [[1, 1, 1], 1, [1, 0, 0]],
    [[1, 1, 1], 2, [1, 1, 0]],
    [[1, 1, 1], 3, [1, 1, 1]],
    [[98, 1, 1], 10, [8, 1, 1]],
    [[98, 1, 1], 100, [98, 1, 1]],
    [[100000, 1, 4], 10, [8, 1, 1]],
    [[5, 0, 5], 3, [2, 0, 1]],
    [[0, 0, 0], 5, [0, 0, 0]],
  ])("distributes %j tokens over %s cells as %j", (weights, cells, expected) => {
    const result = distributeCells(weights, cells);
    expect(result).toEqual(expected);
    expect(result.reduce((sum, value) => sum + value, 0)).toBe(
      weights.some((weight) => weight > 0) ? cells : 0,
    );
  });

  it("splits into tree and preview panes from 80 columns", () => {
    expect(layoutOverlay(79, 24, false).previewWidth).toBe(0);
    expect(layoutOverlay(80, 24, false)).toMatchObject({ treeWidth: 32, previewWidth: 45 });
    expect(layoutOverlay(80, 24, true).previewWidth).toBe(0);
  });

  it("collapses the legend and preview rule on short overlays", () => {
    expect(layoutOverlay(120, 24, false)).toMatchObject({
      showLegend: true,
      roomy: true,
      bodyTop: 8,
      bodyHeight: 13,
      previewHeaderRows: 2,
    });
    expect(layoutOverlay(120, 16, false)).toMatchObject({
      showLegend: true,
      roomy: false,
      bodyTop: 5,
      bodyHeight: 8,
    });
    expect(layoutOverlay(120, 10, false)).toMatchObject({
      showLegend: false,
      roomy: false,
      bodyTop: 4,
      bodyHeight: 3,
      previewHeaderRows: 1,
    });
    const short = renderOverlay(theme, fixtureSnapshot(), layoutOverlay(120, 10, false), [], "");
    expect(short).toHaveLength(10);
    expect(short.join("\n")).not.toContain("■ system");
    expect(short[3]).toMatch(/^├─+┬─+┤$/);
  });

  it("reports unknown usage in the header", () => {
    const lines = renderOverlay(
      theme,
      fixtureSnapshot({ usage: undefined }),
      layoutOverlay(120, 24, false),
      [],
      "",
    ).join("\n");
    expect(lines).toContain("Pi context usage: unknown");
  });
});
