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

const formatClock = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const createTimer = () => {
  let active = false;
  let elapsedMs = 0;
  let segmentStart: number | undefined;
  let promptActive = false;
  // Start time while running, finish time once settled.
  let clockTime: string | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const clear = () => {
    clearInterval(intervalId);
    intervalId = undefined;
  };

  const elapsed = () =>
    elapsedMs + (segmentStart === undefined ? 0 : performance.now() - segmentStart);

  const updateStatus = (ctx: ExtensionContext) => {
    if (clockTime === undefined) {
      return;
    }
    const duration = elapsed();
    const frame =
      intervalId === undefined
        ? STATIC_BREATHING_DOT_FRAME
        : (BREATHING_DOT_FRAMES[
            Math.floor(duration / BREATHING_DOT_INTERVAL_MS) % BREATHING_DOT_FRAMES.length
          ] ?? STATIC_BREATHING_DOT_FRAME);
    ctx.ui.setStatus(
      "timer",
      `${ctx.ui.theme.fg(frame.color, frame.marker)} ${ctx.ui.theme.fg(
        "dim",
        `${formatElapsed(duration)} · ${clockTime}`,
      )}`,
    );
  };

  const startSegment = (ctx: ExtensionContext) => {
    segmentStart = performance.now();
    intervalId = setInterval(() => {
      updateStatus(ctx);
    }, BREATHING_DOT_INTERVAL_MS);
    updateStatus(ctx);
  };

  return {
    dispose() {
      active = false;
      segmentStart = undefined;
      clear();
    },
    pause(ctx: ExtensionContext) {
      promptActive = true;
      if (!active || segmentStart === undefined) {
        return;
      }
      elapsedMs += performance.now() - segmentStart;
      segmentStart = undefined;
      clear();
      updateStatus(ctx);
    },
    resume(ctx: ExtensionContext) {
      promptActive = false;
      if (!active || segmentStart !== undefined) {
        return;
      }
      startSegment(ctx);
    },
    start(ctx: ExtensionContext) {
      if (ctx.mode !== "tui" || active) {
        return;
      }
      active = true;
      elapsedMs = 0;
      segmentStart = undefined;
      clockTime = formatClock(new Date());
      if (promptActive) {
        updateStatus(ctx);
      } else {
        startSegment(ctx);
      }
    },
    stop(ctx: ExtensionContext) {
      if (!active) {
        return;
      }
      if (segmentStart !== undefined) {
        elapsedMs += performance.now() - segmentStart;
        segmentStart = undefined;
      }
      active = false;
      clear();
      clockTime = formatClock(new Date());
      updateStatus(ctx);
    },
  };
};
