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

export const formatElapsed = (ms: number): string => {
  const seconds = ms / 1000;

  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
