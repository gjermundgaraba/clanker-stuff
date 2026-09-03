/**
 * Overlay geometry: pane pixel size, marker-grid phase alignment, backing-scale
 * detection, and the Herdr pane origin.
 *
 * The Ghostty shader looks for marker pairs at absolute screen coordinates that
 * are multiples of `CONTROL_PERIOD`, so the control image must be phase-shifted
 * by the pane origin's remainder modulo the period.
 */

import { execFileSync } from "node:child_process";

import { CONTROL_PERIOD } from "./control-image.js";

export const MAX_OVERLAY_PIXELS = 4096;
export const RESIZE_SETTLE_MS = 120;

export interface OverlayLayout {
  columns: number;
  phaseX: number;
  phaseY: number;
  pixelHeight: number;
  pixelWidth: number;
  rows: number;
}

export interface LayoutContext {
  /** Display backing scale used to convert Ghostty's point padding to pixels. */
  backingScale: number;
  /** Ghostty window padding in points. */
  paddingXPt: number;
  paddingYPt: number;
}

export interface LayoutInput extends LayoutContext {
  cellHeightPx: number;
  cellWidthPx: number;
  columns: number;
  originCellX: number;
  originCellY: number;
  rows: number;
}

export const computeLayout = (input: LayoutInput): OverlayLayout => {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const cellWidth = Math.max(1, Math.floor(input.cellWidthPx));
  const cellHeight = Math.max(1, Math.floor(input.cellHeightPx));
  const pixelWidth = columns * cellWidth;
  const pixelHeight = rows * cellHeight;
  if (pixelWidth > MAX_OVERLAY_PIXELS || pixelHeight > MAX_OVERLAY_PIXELS) {
    throw new Error(
      `pane is ${pixelWidth}x${pixelHeight}px; maximum supported size is ${MAX_OVERLAY_PIXELS}x${MAX_OVERLAY_PIXELS}px`
    );
  }

  const globalPixelX =
    input.originCellX * cellWidth + input.paddingXPt * input.backingScale;
  const globalPixelY =
    input.originCellY * cellHeight + input.paddingYPt * input.backingScale;

  return {
    columns,
    phaseX: (CONTROL_PERIOD - (globalPixelX % CONTROL_PERIOD)) % CONTROL_PERIOD,
    phaseY: (CONTROL_PERIOD - (globalPixelY % CONTROL_PERIOD)) % CONTROL_PERIOD,
    pixelHeight,
    pixelWidth,
    rows,
  };
};

export interface LayoutMetrics {
  cellHeightPx: number;
  cellWidthPx: number;
  columns: number;
  rows: number;
}

export const layoutMetricsChanged = (
  metrics: LayoutMetrics,
  layout: OverlayLayout
): boolean => {
  const columns = Math.max(1, metrics.columns);
  const rows = Math.max(1, metrics.rows);
  const cellWidth = Math.max(1, metrics.cellWidthPx);
  const cellHeight = Math.max(1, metrics.cellHeightPx);
  return (
    columns !== layout.columns ||
    rows !== layout.rows ||
    columns * cellWidth !== layout.pixelWidth ||
    rows * cellHeight !== layout.pixelHeight
  );
};

export interface BackingScaleEstimate {
  confident: boolean;
  scale: number;
}

/**
 * Estimates the display backing scale from Ghostty's configured font size in
 * points and the terminal-reported cell width in backing pixels. Monospace
 * advance widths sit near 0.6 em, so `round(fontPt * 0.6 * scale)` separates
 * the scale candidates by several pixels for any sane font.
 */
export const detectBackingScale = (options: {
  cellWidthPx: number;
  fontPt?: number;
  override?: number;
  platform?: NodeJS.Platform;
}): BackingScaleEstimate => {
  if (
    options.override === 1 ||
    options.override === 2 ||
    options.override === 3
  ) {
    return { confident: true, scale: options.override };
  }

  const { fontPt } = options;
  if (
    fontPt === undefined ||
    !Number.isFinite(fontPt) ||
    fontPt <= 0 ||
    options.cellWidthPx < 1
  ) {
    return {
      confident: false,
      scale: options.platform === "darwin" ? 2 : 1,
    };
  }

  const idealAdvance = fontPt * 0.6;
  const errors = [1, 2, 3]
    .map((scale) => ({
      error: Math.abs(options.cellWidthPx - Math.round(idealAdvance * scale)),
      scale,
    }))
    .toSorted((left, right) => left.error - right.error);
  const best = errors.at(0);
  const runnerUp = errors.at(1);
  if (best === undefined || runnerUp === undefined) {
    return { confident: false, scale: 1 };
  }
  return { confident: runnerUp.error - best.error >= 1, scale: best.scale };
};

interface HerdrPaneRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface HerdrOriginResult {
  originCellX: number;
  originCellY: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseHerdrRect = (paneId: string, pane: unknown): HerdrPaneRect => {
  if (!isRecord(pane) || !isRecord(pane.rect)) {
    throw new TypeError(`could not resolve Herdr layout for ${paneId}`);
  }
  const { rect } = pane;
  const { height, width, x, y } = rect;
  if (
    typeof height !== "number" ||
    typeof width !== "number" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    throw new TypeError(`could not resolve Herdr layout for ${paneId}`);
  }
  return { height, width, x, y };
};

/**
 * Resolves this pane's origin in cells within the outer terminal when running
 * inside Herdr, or `{0, 0}` otherwise. Herdr's public rectangle includes pane
 * chrome, so the leading inset is inferred from the local PTY size.
 */
export const herdrPaneOrigin = (
  columns: number,
  rows: number,
  deps: {
    env: NodeJS.ProcessEnv;
    execLayout: (paneId: string) => string;
  }
): HerdrOriginResult => {
  if (deps.env.HERDR_ENV !== "1") {
    return { originCellX: 0, originCellY: 0 };
  }

  const paneId = deps.env.HERDR_PANE_ID;
  if (paneId === undefined) {
    throw new Error("HERDR_PANE_ID is missing");
  }

  const response: unknown = JSON.parse(deps.execLayout(paneId));
  const rawPanes =
    isRecord(response) &&
    isRecord(response.result) &&
    isRecord(response.result.layout) &&
    Array.isArray(response.result.layout.panes)
      ? response.result.layout.panes
      : [];
  const panes: unknown[] = rawPanes.map((candidate: unknown) => candidate);
  const pane = panes.find(
    (candidate) => isRecord(candidate) && candidate.pane_id === paneId
  );
  const rect = parseHerdrRect(paneId, pane);

  const insetX = Math.max(0, Math.floor((rect.width - columns) / 2));
  const insetY = Math.max(0, Math.floor((rect.height - rows) / 2));
  return { originCellX: rect.x + insetX, originCellY: rect.y + insetY };
};

const execHerdrLayout = (paneId: string): string =>
  execFileSync("herdr", ["pane", "layout", "--pane", paneId], {
    encoding: "utf-8",
    timeout: 1000,
  });

export interface ResolveLayoutDeps {
  cell?: LayoutMetrics;
  env?: NodeJS.ProcessEnv;
  herdrOrigin?: (columns: number, rows: number) => HerdrOriginResult;
  stream: {
    columns?: number;
    rows?: number;
  };
}

/**
 * Gathers the stream size, cell dimensions, and pane origin, then computes the
 * phase-aligned layout for the current environment.
 */
export const resolveLayout = (
  deps: ResolveLayoutDeps,
  context: LayoutContext
): OverlayLayout => {
  const columns = Math.max(1, deps.stream.columns ?? 80);
  const rows = Math.max(1, deps.stream.rows ?? 24);
  const cell =
    deps.cell ??
    (() => {
      throw new Error("cell dimensions are required");
    })();
  const env = deps.env ?? process.env;
  const origin =
    deps.herdrOrigin?.(columns, rows) ??
    herdrPaneOrigin(columns, rows, {
      env,
      execLayout: execHerdrLayout,
    });

  return computeLayout({
    backingScale: context.backingScale,
    cellHeightPx: cell.cellHeightPx,
    cellWidthPx: cell.cellWidthPx,
    columns,
    originCellX: origin.originCellX,
    originCellY: origin.originCellY,
    paddingXPt: context.paddingXPt,
    paddingYPt: context.paddingYPt,
    rows,
  });
};
