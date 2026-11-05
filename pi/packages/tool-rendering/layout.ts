import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const fit = (text: string, width: number): string =>
  truncateToWidth(text, width, "…", true);

export const renderScrollbar = (
  theme: Theme,
  height: number,
  offset: number,
  total: number
): string[] => {
  if (height <= 0) {
    return [];
  }

  if (total <= height) {
    return Array.from({ length: height }, () => " ");
  }

  const thumb = Math.max(1, Math.round((height / total) * height));
  const start = Math.round((offset / (total - height)) * (height - thumb));

  return Array.from({ length: height }, (_, index) =>
    index >= start && index < start + thumb
      ? theme.fg("scrollbarThumb", "┃")
      : theme.fg("dim", "│")
  );
};
