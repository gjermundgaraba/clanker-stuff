import {
  BREATHING_DOT_FRAMES,
  BREATHING_DOT_INTERVAL_MS,
  STATIC_BREATHING_DOT_FRAME,
} from "@clanker-stuff/pi-motion";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const formatElapsed = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const createTimer = () => {
  let startTime: number | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const clear = () => {
    clearInterval(intervalId);
    intervalId = undefined;
  };

  const updateStatus = (ctx: ExtensionContext) => {
    if (startTime === undefined) {
      return;
    }
    const elapsed = performance.now() - startTime;
    const frame =
      intervalId === undefined
        ? STATIC_BREATHING_DOT_FRAME
        : (BREATHING_DOT_FRAMES[
            Math.floor(elapsed / BREATHING_DOT_INTERVAL_MS) %
              BREATHING_DOT_FRAMES.length
          ] ?? STATIC_BREATHING_DOT_FRAME);
    ctx.ui.setStatus(
      "timer",
      `${ctx.ui.theme.fg(frame.color, frame.marker)} ${ctx.ui.theme.fg("dim", formatElapsed(elapsed))}`
    );
  };

  return {
    dispose: clear,
    start(ctx: ExtensionContext) {
      if (ctx.mode !== "tui" || startTime !== undefined) {
        return;
      }
      startTime = performance.now();
      intervalId = setInterval(() => {
        updateStatus(ctx);
      }, BREATHING_DOT_INTERVAL_MS);
      updateStatus(ctx);
    },
    stop(ctx: ExtensionContext) {
      clear();
      updateStatus(ctx);
      startTime = undefined;
    },
  };
};
