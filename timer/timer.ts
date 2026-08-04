import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const TIMER_INTERVAL_MS = 100;
const STATUS_KEY = "timer";

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
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  };

  const updateStatus = (ctx: ExtensionContext) => {
    if (startTime !== undefined) {
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("dim", formatElapsed(Date.now() - startTime))
      );
    }
  };

  return {
    dispose() {
      clear();
      startTime = undefined;
    },
    start(ctx: ExtensionContext) {
      if (startTime !== undefined) {
        return;
      }
      startTime = Date.now();
      updateStatus(ctx);
      intervalId = setInterval(() => {
        updateStatus(ctx);
      }, TIMER_INTERVAL_MS);
    },
    stop(ctx: ExtensionContext) {
      clear();
      updateStatus(ctx);
      startTime = undefined;
    },
  };
};
