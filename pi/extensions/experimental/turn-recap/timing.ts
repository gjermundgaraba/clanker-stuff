/** Monotonic run timing; wall-clock timestamps are only for the displayed clock. */
export const createTiming = (paused: boolean) => {
  const startedAt = Date.now();
  const started = performance.now();
  let segmentStart = paused ? undefined : started;
  let activeMs = 0;

  return {
    pause() {
      if (segmentStart === undefined) return;
      activeMs += performance.now() - segmentStart;
      segmentStart = undefined;
    },
    resume() {
      segmentStart ??= performance.now();
    },
    read() {
      const now = performance.now();

      return {
        startedAt,
        activeMs: activeMs + (segmentStart === undefined ? 0 : now - segmentStart),
        wallMs: now - started,
      };
    },
  };
};

export const formatElapsed = (ms: number, precision: "seconds" | "tenths" = "tenths"): string => {
  const seconds = precision === "seconds" ? Math.floor(ms / 1000) : Math.round(ms / 100) / 10;

  if (seconds < 60) return `${precision === "seconds" ? seconds : seconds.toFixed(1)}s`;
  const pad = (value: number) => String(Math.floor(value)).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);

  return minutes < 60
    ? `${minutes}:${pad(seconds % 60)}`
    : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
};
