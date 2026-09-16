import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Bound visual rows, recreating themed content after invalidation. */
export function preview(
  create: () => Component,
  expanded: boolean,
  limit = 5,
  edge: "head" | "tail" = "head",
): Component {
  let child: Component | undefined;
  let cachedWidth: number | undefined;
  let rows: string[] = [];
  return {
    invalidate() {
      child = undefined;
      cachedWidth = undefined;
    },
    render(width) {
      if (cachedWidth === width) return rows;
      child ??= create();
      const all = child.render(width);
      if (expanded || all.length <= limit) rows = all;
      else {
        const tail = edge === "tail";
        const hint = `… ${all.length - limit} ${tail ? "earlier " : "more "}lines · ${keyHint("app.tools.expand", "to expand")}`;
        rows = tail ? [hint, ...all.slice(-limit)] : [...all.slice(0, limit), hint];
      }
      // A wide glyph can exceed a one-column Text layout. Guard only emitted rows.
      rows = rows.map((row) => truncateToWidth(row, width, ""));
      cachedWidth = width;
      return rows;
    },
  };
}
