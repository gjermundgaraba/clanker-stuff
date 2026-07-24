import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

export default function timerExtension(pi: ExtensionAPI) {
  let startTime: number | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const clearTimer = () => {
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

  pi.on("agent_start", (_event, ctx) => {
    if (startTime !== undefined) {
      return;
    }
    startTime = Date.now();
    updateStatus(ctx);
    intervalId = setInterval(() => {
      updateStatus(ctx);
    }, TIMER_INTERVAL_MS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    clearTimer();
    updateStatus(ctx);
    startTime = undefined;
  });

  pi.on("session_shutdown", () => {
    clearTimer();
    startTime = undefined;
  });
}
