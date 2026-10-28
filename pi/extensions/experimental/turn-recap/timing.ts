export const createTiming = () => {
  const startedAt = Date.now();
  const started = performance.now();

  return {
    read: () => ({ startedAt, wallMs: performance.now() - started }),
  };
};

const pad = (value: number) => String(Math.floor(value)).padStart(2, "0");

export const formatElapsed = (
  ms: number,
  precision: "seconds" | "tenths" = "tenths"
): string => {
  const seconds =
    precision === "seconds" ? Math.floor(ms / 1000) : Math.round(ms / 100) / 10;

  if (seconds < 60) {
    return `${precision === "seconds" ? seconds : seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60
    ? `${minutes}:${pad(seconds % 60)}`
    : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
};
