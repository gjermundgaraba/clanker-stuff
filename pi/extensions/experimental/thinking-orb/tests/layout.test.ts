import { describe, expect, it } from "vitest";

import {
  detectBackingScale,
  computeLayout,
  herdrPaneOrigin,
  layoutMetricsChanged,
  resolveLayout,
} from "../layout.js";

describe(computeLayout, () => {
  it("computes pane pixels from cells and cell dimensions", () => {
    const layout = computeLayout({
      backingScale: 1,
      cellHeightPx: 18,
      cellWidthPx: 9,
      columns: 80,
      originCellX: 0,
      originCellY: 0,
      paddingXPt: 0,
      paddingYPt: 0,
      rows: 24,
    });
    expect(layout.pixelWidth).toBe(720);
    expect(layout.pixelHeight).toBe(432);
    expect(layout.phaseX).toBe(0);
    expect(layout.phaseY).toBe(0);
  });

  it("phase-aligns the marker grid to the absolute screen origin", () => {
    const layout = computeLayout({
      backingScale: 1,
      cellHeightPx: 18,
      cellWidthPx: 3,
      columns: 16,
      originCellX: 1,
      originCellY: 0,
      paddingXPt: 0,
      paddingYPt: 0,
      rows: 4,
    });
    expect(layout.phaseX).toBe(5);
    expect(layout.phaseY).toBe(0);
  });

  it("scales point padding into the pixel phase", () => {
    const layout = computeLayout({
      backingScale: 2,
      cellHeightPx: 18,
      cellWidthPx: 9,
      columns: 16,
      originCellX: 0,
      originCellY: 0,
      paddingXPt: 2,
      paddingYPt: 2,
      rows: 4,
    });
    expect(layout.phaseX).toBe(4);
    expect(layout.phaseY).toBe(4);
  });

  it("rejects panes beyond the maximum texture size", () => {
    expect(() =>
      computeLayout({
        backingScale: 1,
        cellHeightPx: 9,
        cellWidthPx: 9,
        columns: 600,
        originCellX: 0,
        originCellY: 0,
        paddingXPt: 0,
        paddingYPt: 0,
        rows: 24,
      })
    ).toThrow(/maximum supported size/u);
  });
});

describe(layoutMetricsChanged, () => {
  const layout = computeLayout({
    backingScale: 1,
    cellHeightPx: 18,
    cellWidthPx: 9,
    columns: 80,
    originCellX: 0,
    originCellY: 0,
    paddingXPt: 0,
    paddingYPt: 0,
    rows: 24,
  });

  it("returns false for matching metrics", () => {
    expect(
      layoutMetricsChanged(
        { cellHeightPx: 18, cellWidthPx: 9, columns: 80, rows: 24 },
        layout
      )
    ).toBeFalsy();
  });

  it("returns true when columns or cells change", () => {
    expect(
      layoutMetricsChanged(
        { cellHeightPx: 18, cellWidthPx: 9, columns: 81, rows: 24 },
        layout
      )
    ).toBeTruthy();
    expect(
      layoutMetricsChanged(
        { cellHeightPx: 19, cellWidthPx: 9, columns: 80, rows: 24 },
        layout
      )
    ).toBeTruthy();
  });
});

describe(detectBackingScale, () => {
  it("prefers an explicit override", () => {
    expect(
      detectBackingScale({ cellWidthPx: 16, fontPt: 13, override: 3 })
    ).toStrictEqual({ confident: true, scale: 3 });
  });

  it("separates retina from non-retina cell widths", () => {
    expect(detectBackingScale({ cellWidthPx: 16, fontPt: 13 })).toStrictEqual({
      confident: true,
      scale: 2,
    });
    expect(detectBackingScale({ cellWidthPx: 8, fontPt: 13 })).toStrictEqual({
      confident: true,
      scale: 1,
    });
    expect(detectBackingScale({ cellWidthPx: 29, fontPt: 24 })).toStrictEqual({
      confident: true,
      scale: 2,
    });
  });

  it("falls back to the platform default without a font size", () => {
    expect(
      detectBackingScale({
        cellWidthPx: 16,
        fontPt: undefined,
        platform: "darwin",
      })
    ).toStrictEqual({ confident: false, scale: 2 });
    expect(
      detectBackingScale({
        cellWidthPx: 8,
        fontPt: undefined,
        platform: "linux",
      })
    ).toStrictEqual({ confident: false, scale: 1 });
  });
});

describe(herdrPaneOrigin, () => {
  const layoutJson = JSON.stringify({
    result: {
      layout: {
        panes: [
          {
            pane_id: "p1",
            rect: { height: 24, width: 80, x: 2, y: 3 },
          },
        ],
      },
    },
  });

  it("returns the origin at zero outside Herdr", () => {
    expect(
      herdrPaneOrigin(80, 24, { env: {}, execLayout: () => layoutJson })
    ).toStrictEqual({ originCellX: 0, originCellY: 0 });
  });

  it("adds the inferred chrome inset to the pane rectangle", () => {
    expect(
      herdrPaneOrigin(78, 22, {
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "p1" },
        execLayout: () => layoutJson,
      })
    ).toStrictEqual({ originCellX: 3, originCellY: 4 });
  });

  it("throws when Herdr does not report the pane", () => {
    expect(() =>
      herdrPaneOrigin(78, 22, {
        env: { HERDR_ENV: "1" },
        execLayout: () => layoutJson,
      })
    ).toThrow(/HERDR_PANE_ID is missing/u);

    expect(() =>
      herdrPaneOrigin(78, 22, {
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "p2" },
        execLayout: () => layoutJson,
      })
    ).toThrow(/could not resolve Herdr layout/u);
  });
});

describe(resolveLayout, () => {
  it("combines stream size, cell dimensions, and injected origin", () => {
    const layout = resolveLayout(
      {
        cell: { cellHeightPx: 18, cellWidthPx: 9, columns: 80, rows: 24 },
        env: {},
        herdrOrigin: () => ({ originCellX: 1, originCellY: 1 }),
        stream: { columns: 80, rows: 24 },
      },
      { backingScale: 1, paddingXPt: 0, paddingYPt: 0 }
    );
    expect(layout.pixelWidth).toBe(720);
    expect(layout.phaseX).toBe((8 - (9 % 8)) % 8);
    expect(layout.phaseY).toBe((8 - (18 % 8)) % 8);
  });

  it("requires cell dimensions when not injected", () => {
    expect(() =>
      resolveLayout(
        { stream: { columns: 80, rows: 24 } },
        {
          backingScale: 1,
          paddingXPt: 0,
          paddingYPt: 0,
        }
      )
    ).toThrow(/cell dimensions are required/u);
  });
});
