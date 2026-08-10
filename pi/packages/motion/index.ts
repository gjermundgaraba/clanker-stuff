export const BREATHING_DOT_INTERVAL_MS = 130;

export const BREATHING_DOT_FRAMES = [
  { color: "dim", marker: "·" },
  { color: "dim", marker: "•" },
  { color: "muted", marker: "•" },
  { color: "muted", marker: "●" },
  { color: "accent", marker: "●" },
  { color: "accent", marker: "●" },
  { color: "muted", marker: "●" },
  { color: "muted", marker: "•" },
  { color: "dim", marker: "•" },
  { color: "dim", marker: "·" },
  { color: "dim", marker: "·" },
  { color: "dim", marker: "·" },
] as const;

export const STATIC_BREATHING_DOT_FRAME = {
  color: "muted",
  marker: "●",
} as const;
