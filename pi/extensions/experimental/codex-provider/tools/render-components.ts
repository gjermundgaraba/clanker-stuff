import type { Box, Component } from "@earendil-works/pi-tui";

/** Cache one layout, not every width visited. Renderer callbacks replace it when data changes. */
export const cachedLines = (
  draw: (width: number) => string[],
  invalidateChildren?: () => void,
): Component => {
  let cachedWidth: number | undefined;
  let lines: string[] = [];
  return {
    invalidate() {
      cachedWidth = undefined;
      invalidateChildren?.();
    },
    render(width) {
      if (cachedWidth !== width) {
        lines = draw(width);
        cachedWidth = width;
      }
      return lines;
    },
  };
};

/**
 * Box's own cache still draws every child and compares every line. Cache outside the box so
 * expanded trace prefixes and ANSI width scans also stay off the redraw path. Use for display-only
 * tool snapshots: data changes replace the component; theme/delegated updates invalidate the row.
 */
export const cachedBox = (box: Box): Component =>
  cachedLines(
    (width) => box.render(width),
    () => box.invalidate(),
  );

/** Prepare once after both renderer slots have run; resizing only lays out the retained child. */
export const lazyComponent = (create: () => Component): Component => {
  let child: Component | undefined;
  return {
    invalidate() {
      child = undefined;
    },
    render(width) {
      child ??= create();
      return child.render(width);
    },
  };
};
