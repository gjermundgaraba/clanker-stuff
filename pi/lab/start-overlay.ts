/**
 * A pane-local Thinking Orb overlay for Ghostty.
 *
 * Ghostty config:
 *   custom-shader = /absolute/path/to/shaders/ghostty/thinking-orb-overlay.glsl
 *   custom-shader-animation = false
 *
 * Pi:
 *   pi --extension ./pi/lab/start-overlay.ts
 *   /start-overlay
 *
 * Standalone:
 *   node --experimental-strip-types pi/lab/start-overlay.ts --standalone
 *
 * A sparse, transparent coordinate texture gives the GPU pane-local geometry
 * once. A transparent one-pixel heartbeat then requests frames; rendered
 * animation pixels never cross the PTY.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { deflateSync, inflateSync } from "node:zlib";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { allocateImageId, getCellDimensions } from "@earendil-works/pi-tui";

const ESC = "\u001B";
const CONTROL_IMAGE_ID = allocateImageId();
const HEARTBEAT_IMAGE_ID = allocateImageId();
const CONTROL_PLACEMENT_ID = 1;
const HEARTBEAT_PLACEMENT_ID = 2;

const CONTROL_Z_INDEX = 2;
const HEARTBEAT_Z_INDEX = 3;
const CONTROL_PERIOD = 8;
const COORDINATE_RANGE = 8;

const FPS = 60;
const FRAME_INTERVAL_MS = 1000 / FPS;
const RESIZE_SETTLE_MS = 120;

interface OverlayLayout {
  columns: number;
  phaseX: number;
  phaseY: number;
  pixelHeight: number;
  pixelWidth: number;
  rows: number;
}

interface OverlayRuntime {
  controlRefreshAt?: number;
  layout: OverlayLayout;
  markerState: boolean;
  nextFrameAt: number;
  out: NodeJS.WriteStream;
  started: boolean;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  waitingForDrain: boolean;
}

interface HerdrLayoutResponse {
  result?: {
    layout?: {
      panes?: {
        pane_id?: string;
        rect?: {
          height?: number;
          width?: number;
          x?: number;
          y?: number;
        };
      }[];
    };
  };
}

const ghosttyPaddingPixels = (): { x: number; y: number } => {
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "ghostty") {
    return { x: 0, y: 0 };
  }

  let x = 2;
  let y = 2;
  try {
    const config = execFileSync("ghostty", ["+show-config"], {
      encoding: "utf-8",
      timeout: 1000,
    });
    const configuredX = /^window-padding-x\s*=\s*(?<value>\d+)/mu.exec(config);
    const configuredY = /^window-padding-y\s*=\s*(?<value>\d+)/mu.exec(config);
    x = configuredX?.groups ? Number(configuredX.groups.value) : x;
    y = configuredY?.groups ? Number(configuredY.groups.value) : y;
  } catch {
    // Ghostty's default padding is two points on each edge.
  }

  // Ghostty config uses logical points; terminal pixel reports and shader
  // coordinates use backing pixels.
  const backingScale = process.platform === "darwin" ? 2 : 1;
  return { x: x * backingScale, y: y * backingScale };
};

const runtime: OverlayRuntime = {
  layout: {
    columns: 1,
    phaseX: 0,
    phaseY: 0,
    pixelHeight: 1,
    pixelWidth: 1,
    rows: 1,
  },
  markerState: false,
  nextFrameAt: 0,
  out: process.stdout,
  started: false,
  stopped: false,
  waitingForDrain: false,
};

const herdrPaneOrigin = (
  columns: number,
  rows: number
): { x: number; y: number } => {
  if (process.env.HERDR_ENV !== "1") {
    return { x: 0, y: 0 };
  }

  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error("HERDR_PANE_ID is missing");
  }

  const output = execFileSync("herdr", ["pane", "layout", "--pane", paneId], {
    encoding: "utf-8",
    timeout: 1000,
  });
  const response = JSON.parse(output) as HerdrLayoutResponse;
  const pane = response.result?.layout?.panes?.find(
    (candidate) => candidate.pane_id === paneId
  );
  const height = pane?.rect?.height;
  const width = pane?.rect?.width;
  const x = pane?.rect?.x;
  const y = pane?.rect?.y;
  if (
    typeof height !== "number" ||
    typeof width !== "number" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    throw new TypeError(`could not resolve Herdr layout for ${paneId}`);
  }

  // Herdr's public rectangle includes pane chrome, while Kitty placements are
  // translated into the inner PTY rectangle. Infer the leading inset from the
  // local PTY size so this also works when borders or scrollbars change.
  const insetX = Math.max(0, Math.floor((width - columns) / 2));
  const insetY = Math.max(0, Math.floor((height - rows) / 2));
  return { x: x + insetX, y: y + insetY };
};

const calculateLayout = (out: NodeJS.WriteStream): OverlayLayout => {
  const columns = Math.max(1, out.columns ?? 80);
  const rows = Math.max(1, out.rows ?? 24);
  const cell = getCellDimensions();
  const cellWidth = Math.max(1, cell.widthPx);
  const cellHeight = Math.max(1, cell.heightPx);
  const pixelWidth = columns * cellWidth;
  const pixelHeight = rows * cellHeight;
  if (pixelWidth > 4096 || pixelHeight > 4096) {
    throw new Error(
      `pane is ${pixelWidth}x${pixelHeight}px; maximum supported size is 4096x4096px`
    );
  }

  const origin = herdrPaneOrigin(columns, rows);
  const padding = ghosttyPaddingPixels();
  const globalPixelX = origin.x * cellWidth + padding.x;
  const globalPixelY = origin.y * cellHeight + padding.y;

  return {
    columns,
    phaseX: (CONTROL_PERIOD - (globalPixelX % CONTROL_PERIOD)) % CONTROL_PERIOD,
    phaseY: (CONTROL_PERIOD - (globalPixelY % CONTROL_PERIOD)) % CONTROL_PERIOD,
    pixelHeight,
    pixelWidth,
    rows,
  };
};

const layoutMetricsChanged = (
  out: NodeJS.WriteStream,
  layout: OverlayLayout
): boolean => {
  const cell = getCellDimensions();
  const cellWidth = cell.widthPx;
  const cellHeight = cell.heightPx;
  const columns = Math.max(1, out.columns ?? 80);
  const rows = Math.max(1, out.rows ?? 24);
  return (
    columns !== layout.columns ||
    rows !== layout.rows ||
    columns * cellWidth !== layout.pixelWidth ||
    rows * cellHeight !== layout.pixelHeight
  );
};

const encodeCoordinate = (coordinate: number): number => {
  const normalized =
    (Math.max(-COORDINATE_RANGE, Math.min(COORDINATE_RANGE, coordinate)) +
      COORDINATE_RANGE) /
    (COORDINATE_RANGE * 2);
  return Math.round(normalized * 65_535);
};

const renderControlImage = (layout: OverlayLayout): Buffer => {
  const buffer = Buffer.alloc(layout.pixelWidth * layout.pixelHeight * 4);
  const minimumSize = Math.min(layout.pixelWidth, layout.pixelHeight);

  for (let y = layout.phaseY; y < layout.pixelHeight; y += CONTROL_PERIOD) {
    const yCoordinate =
      ((layout.pixelHeight / 2 - (y + 0.5)) * 2) / minimumSize;
    const encodedY = encodeCoordinate(yCoordinate);

    for (
      let x = layout.phaseX;
      x + 1 < layout.pixelWidth;
      x += CONTROL_PERIOD
    ) {
      const xCoordinate = ((x + 0.5 - layout.pixelWidth / 2) * 2) / minimumSize;
      const encodedX = encodeCoordinate(xCoordinate);
      const offset = (y * layout.pixelWidth + x) * 4;

      buffer[offset] = 248;
      buffer[offset + 1] = Math.floor(encodedX / 256);
      buffer[offset + 2] = encodedX % 256;
      buffer[offset + 3] = 255;

      buffer[offset + 4] = 249;
      buffer[offset + 5] = Math.floor(encodedY / 256);
      buffer[offset + 6] = encodedY % 256;
      buffer[offset + 7] = 255;
    }
  }

  return buffer;
};

const encodedPayload = (pixels: Buffer): string => pixels.toString("base64");

const HEARTBEAT_PAYLOADS = [
  encodedPayload(Buffer.from([0, 0, 0, 0])),
  encodedPayload(Buffer.from([0, 0, 1, 0])),
] as const;

const kittyChunks = (payload: string, controls: string): string => {
  const chunks: string[] = [];

  for (let offset = 0; offset < payload.length; offset += 4096) {
    const first = offset === 0;
    const last = offset + 4096 >= payload.length;
    const chunkControls = first
      ? `${controls},m=${last ? 0 : 1}`
      : `m=${last ? 0 : 1}`;
    chunks.push(
      `${ESC}_G${chunkControls};${payload.slice(offset, offset + 4096)}${ESC}\\`
    );
  }

  return chunks.join("");
};

const deleteImages = (): string =>
  [
    `${ESC}_Ga=d,d=I,i=${CONTROL_IMAGE_ID},q=2${ESC}\\`,
    `${ESC}_Ga=d,d=I,i=${HEARTBEAT_IMAGE_ID},q=2${ESC}\\`,
  ].join("");

const controlPayload = (layout: OverlayLayout): string =>
  deflateSync(renderControlImage(layout), {
    level: 6,
  }).toString("base64");

const placeControlImage = (
  out: NodeJS.WriteStream,
  layout: OverlayLayout
): boolean => {
  const payload = controlPayload(layout);
  const sequence = [
    `${ESC}[?2026h${ESC}7${ESC}[1;1H`,
    kittyChunks(
      payload,
      `a=T,f=32,o=z,s=${layout.pixelWidth},v=${layout.pixelHeight},i=${CONTROL_IMAGE_ID},p=${CONTROL_PLACEMENT_ID},z=${CONTROL_Z_INDEX},c=${layout.columns},r=${layout.rows},q=2,C=1`
    ),
    `${ESC}8${ESC}[?2026l`,
  ].join("");

  return out.write(sequence);
};

const updateFrame = (out: NodeJS.WriteStream, payload: string): boolean =>
  out.write(
    [
      `${ESC}[?2026h${ESC}7${ESC}[1;1H`,
      kittyChunks(
        payload,
        `a=T,f=32,s=1,v=1,i=${HEARTBEAT_IMAGE_ID},p=${HEARTBEAT_PLACEMENT_ID},z=${HEARTBEAT_Z_INDEX},q=2,C=1`
      ),
      `${ESC}8${ESC}[?2026l`,
    ].join("")
  );

const frameLoop = (): void => {
  if (runtime.stopped || !runtime.started) {
    return;
  }

  const now = performance.now();
  if (now < runtime.nextFrameAt) {
    runtime.timer = setTimeout(frameLoop, runtime.nextFrameAt - now);
    return;
  }
  if (runtime.nextFrameAt <= now - FRAME_INTERVAL_MS) {
    const missedFrames = Math.floor(
      (now - runtime.nextFrameAt) / FRAME_INTERVAL_MS
    );
    runtime.nextFrameAt += missedFrames * FRAME_INTERVAL_MS;
  }
  runtime.nextFrameAt += FRAME_INTERVAL_MS;
  runtime.markerState = !runtime.markerState;

  if (layoutMetricsChanged(runtime.out, runtime.layout)) {
    runtime.layout = calculateLayout(runtime.out);
    runtime.controlRefreshAt = now + RESIZE_SETTLE_MS;
  }

  let accepted = true;
  if (
    runtime.controlRefreshAt !== undefined &&
    now >= runtime.controlRefreshAt
  ) {
    runtime.controlRefreshAt = undefined;
    accepted = placeControlImage(runtime.out, runtime.layout);
  }

  accepted =
    updateFrame(runtime.out, HEARTBEAT_PAYLOADS[Number(runtime.markerState)]) &&
    accepted;

  if (accepted) {
    runtime.waitingForDrain = false;
    const delay = Math.max(0, runtime.nextFrameAt - performance.now());
    runtime.timer = setTimeout(frameLoop, delay);
  } else {
    runtime.waitingForDrain = true;
    runtime.out.once("drain", () => {
      runtime.waitingForDrain = false;
      const delay = Math.max(0, runtime.nextFrameAt - performance.now());
      runtime.timer = setTimeout(frameLoop, delay);
    });
  }
};

const startOverlay = (out = process.stdout): void => {
  if (runtime.started) {
    return;
  }

  const layout = calculateLayout(out);
  const accepted = placeControlImage(out, layout);

  runtime.started = true;
  runtime.stopped = false;
  runtime.out = out;
  runtime.layout = layout;
  runtime.markerState = false;
  runtime.nextFrameAt = performance.now() + FRAME_INTERVAL_MS;
  runtime.controlRefreshAt = undefined;

  if (accepted) {
    runtime.timer = setTimeout(frameLoop, FRAME_INTERVAL_MS);
    return;
  }

  runtime.waitingForDrain = true;
  out.once("drain", () => {
    runtime.waitingForDrain = false;
    if (runtime.started && !runtime.stopped) {
      runtime.timer = setTimeout(frameLoop, FRAME_INTERVAL_MS);
    }
  });
};

const stopOverlay = (): void => {
  if (!runtime.started || runtime.stopped) {
    return;
  }

  runtime.stopped = true;
  runtime.started = false;
  runtime.controlRefreshAt = undefined;
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = undefined;
  }
  runtime.out.write(`${ESC}[?2026h${deleteImages()}${ESC}[?25h${ESC}[?2026l`);
};

const startOverlayExtension = (pi: ExtensionAPI): void => {
  const isGhostty = process.env.TERM_PROGRAM?.toLowerCase() === "ghostty";

  pi.registerCommand("start-overlay", {
    description: "Start the pane-local Ghostty Thinking Orb overlay",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !isGhostty || !process.stdout.isTTY) {
        ctx.ui.notify("The Thinking Orb requires Ghostty's TUI.", "error");
        return;
      }

      try {
        startOverlay();
      } catch (error) {
        stopOverlay();
        const message =
          error instanceof Error ? error.message : "unknown rendering error";
        ctx.ui.notify(`Could not start the Thinking Orb: ${message}`, "error");
      }
    },
  });
  pi.registerCommand("stop-overlay", {
    description: "Stop and remove the Ghostty Thinking Orb overlay",
    handler: async () => {
      stopOverlay();
    },
  });

  pi.on("session_shutdown", () => {
    stopOverlay();
  });
};

export default startOverlayExtension;

const checkOverlay = (): void => {
  const layout: OverlayLayout = {
    columns: 4,
    phaseX: 2,
    phaseY: 4,
    pixelHeight: 16,
    pixelWidth: 24,
    rows: 2,
  };
  const control = renderControlImage(layout);
  const compressed = deflateSync(control, { level: 6 });
  const offset = (layout.phaseY * layout.pixelWidth + layout.phaseX) * 4;
  const chunks = kittyChunks("x".repeat(5000), "a=t,f=32,s=1,v=1,i=1,q=2");
  let frameBytes = 0;

  assert.equal(control.length, layout.pixelWidth * layout.pixelHeight * 4);
  assert.deepEqual(inflateSync(compressed), control);
  assert.equal(control[offset], 248);
  assert.equal(control[offset + 4], 249);
  assert.equal(control[offset - 4], 0);
  assert.equal(control[offset + 3], 255);
  assert.equal(control[offset + 7], 255);
  assert.equal(chunks.split(`${ESC}_G`).length - 1, 2);
  assert.ok(chunks.includes("q=2,m=1;"));
  assert.ok(chunks.includes(`${ESC}_Gm=0;`));
  assert.ok(
    updateFrame(
      {
        write: (sequence: string) => {
          frameBytes = Buffer.byteLength(sequence);
          return frameBytes < 256;
        },
      } as NodeJS.WriteStream,
      HEARTBEAT_PAYLOADS[0]
    )
  );
  assert.ok(frameBytes < 192);

  console.log(
    `Overlay check passed: ${control.length} raw control bytes, ${compressed.length} compressed bytes, and ${frameBytes} PTY bytes per frame.`
  );
};

if (process.argv.includes("--check")) {
  checkOverlay();
} else if (process.argv.includes("--standalone")) {
  process.on("SIGINT", () => {
    stopOverlay();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopOverlay();
    process.exit(0);
  });
  startOverlay();
}
