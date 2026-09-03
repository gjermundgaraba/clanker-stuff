/**
 * Overlay runtime controller: places the coordinate texture once, then drives
 * the one-pixel heartbeat at the configured frame rate. Rendered animation
 * pixels never cross the PTY; each frame costs well under 200 bytes.
 */

import { controlSequence, deleteSequence, heartbeatSequence } from "./kitty.js";
import { RESIZE_SETTLE_MS, layoutMetricsChanged } from "./layout.js";
import type { LayoutMetrics, OverlayLayout } from "./layout.js";

export type OverlayMode = "auto" | "manual";

export interface OverlayStatus {
  frames: number;
  layout?: OverlayLayout;
  lastError?: string;
  mode?: OverlayMode;
  running: boolean;
  waitingForDrain: boolean;
}

export interface OverlayControllerDeps {
  /** Current pane metrics for cheap per-frame resize detection. */
  metrics: () => LayoutMetrics;
  now?: () => number;
  out: NodeJS.WriteStream;
  /** Computes a fresh phase-aligned layout for the current environment. */
  layout: () => OverlayLayout;
  fps?: number;
}

export interface OverlayController {
  start: (mode: OverlayMode) => void;
  status: () => OverlayStatus;
  stop: () => void;
}

interface FrameState {
  controlRefreshAt?: number;
  frames: number;
  lastError?: string;
  layout: OverlayLayout;
  markerState: boolean;
  mode: OverlayMode;
  nextFrameAt: number;
  timer?: ReturnType<typeof setTimeout>;
  waitingForDrain: boolean;
}

export const createOverlayController = (
  deps: OverlayControllerDeps
): OverlayController => {
  const fps = deps.fps ?? 60;
  const frameIntervalMs = 1000 / fps;
  const now = deps.now ?? (() => performance.now());

  let running = false;
  let state: FrameState | undefined;
  let drainListener: (() => void) | undefined;

  const cancelTimer = (): void => {
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const frameLoop = (): void => {
    if (!running || !state) {
      return;
    }

    const timestamp = now();
    if (timestamp < state.nextFrameAt) {
      state.timer = setTimeout(frameLoop, state.nextFrameAt - timestamp);
      return;
    }
    if (state.nextFrameAt <= timestamp - frameIntervalMs) {
      const missedFrames = Math.floor(
        (timestamp - state.nextFrameAt) / frameIntervalMs
      );
      state.nextFrameAt += missedFrames * frameIntervalMs;
    }
    state.nextFrameAt += frameIntervalMs;
    state.markerState = !state.markerState;

    if (layoutMetricsChanged(deps.metrics(), state.layout)) {
      try {
        state.layout = deps.layout();
      } catch (error) {
        state.lastError =
          error instanceof Error ? error.message : String(error);
        running = false;
        return;
      }
      state.controlRefreshAt = timestamp + RESIZE_SETTLE_MS;
    }

    let accepted = true;
    if (
      state.controlRefreshAt !== undefined &&
      timestamp >= state.controlRefreshAt
    ) {
      state.controlRefreshAt = undefined;
      accepted = deps.out.write(controlSequence(state.layout));
    }

    accepted =
      deps.out.write(heartbeatSequence(state.markerState ? 1 : 0)) && accepted;
    if (accepted) {
      state.frames += 1;
      state.waitingForDrain = false;
      state.timer = setTimeout(
        frameLoop,
        Math.max(0, state.nextFrameAt - now())
      );
      return;
    }

    state.waitingForDrain = true;
    drainListener = () => {
      drainListener = undefined;
      if (!running || !state) {
        return;
      }
      state.waitingForDrain = false;
      state.timer = setTimeout(
        frameLoop,
        Math.max(0, state.nextFrameAt - now())
      );
    };
    deps.out.once("drain", drainListener);
  };

  return {
    start(mode: OverlayMode): void {
      if (running) {
        return;
      }

      const layout = deps.layout();
      const accepted = deps.out.write(controlSequence(layout));

      running = true;
      state = {
        frames: 0,
        layout,
        markerState: false,
        mode,
        nextFrameAt: now() + frameIntervalMs,
        waitingForDrain: false,
      };

      if (accepted) {
        state.timer = setTimeout(frameLoop, frameIntervalMs);
        return;
      }

      state.waitingForDrain = true;
      drainListener = () => {
        drainListener = undefined;
        if (!running || !state) {
          return;
        }
        state.waitingForDrain = false;
        state.timer = setTimeout(frameLoop, frameIntervalMs);
      };
      deps.out.once("drain", drainListener);
    },

    status(): OverlayStatus {
      return {
        frames: state?.frames ?? 0,
        lastError: state?.lastError,
        layout: state?.layout,
        mode: state?.mode,
        running,
        waitingForDrain: state?.waitingForDrain ?? false,
      };
    },

    stop(): void {
      if (!running) {
        return;
      }

      running = false;
      if (drainListener) {
        deps.out.removeListener("drain", drainListener);
        drainListener = undefined;
      }
      cancelTimer();
      state = undefined;
      deps.out.write(deleteSequence());
    },
  };
};
