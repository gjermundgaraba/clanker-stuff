import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Bound visual rows, recreating themed content after invalidation. */
export const preview = (
  create: () => Component,
  expanded: boolean,
  limit = 5,
  edge: "head" | "tail" = "head"
): Component => {
  let child: Component | undefined;
  let cache: { width: number; rows: string[] } | undefined;

  return {
    invalidate() {
      child = undefined;
      cache = undefined;
    },
    render(width) {
      if (cache?.width === width) {
        return cache.rows;
      }

      child ??= create();
      let rows = child.render(width);

      if (!expanded && rows.length > limit) {
        const tail = edge === "tail";
        const hint = `… ${rows.length - limit} ${tail ? "earlier" : "more"} lines · ${keyHint("app.tools.expand", "to expand")}`;
        rows = tail
          ? [hint, ...rows.slice(-limit)]
          : [...rows.slice(0, limit), hint];
      }

      // A wide glyph can exceed a one-column Text layout. Guard only emitted rows.
      cache = {
        width,
        rows: rows.map((row) => truncateToWidth(row, width, "")),
      };

      return cache.rows;
    },
  };
};
