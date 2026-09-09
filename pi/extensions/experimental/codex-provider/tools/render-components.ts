import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { Box, Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

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

const expandHint = (theme: Theme, label: string): string =>
  `${theme.fg("muted", `${label} ·`)} ${keyHint("app.tools.expand", "to expand")}`;

/** Keep the last N visual rows, with a leading gap and an expand hint when output was hidden. */
export const tailPreview = (text: string, maxLines: number, theme: Theme): Component =>
  cachedLines((width) => {
    const { visualLines, skippedCount } = truncateToVisualLines(text, maxLines, width);
    return [
      "",
      ...(skippedCount > 0
        ? [truncateToWidth(expandHint(theme, `… ${skippedCount} earlier lines`), width, "...")]
        : []),
      ...visualLines,
    ];
  });

/** Highlighting is prepared by the caller; this component only wraps and limits screen rows. */
export const codeBlockComponent = (
  styledText: string,
  theme: Theme,
  expanded: boolean,
  previewLines: number,
): Component => {
  const text = new Text(styledText, 0, 0);
  if (expanded) return text;
  return cachedLines(
    (width) => {
      const all = text.render(width);
      return all.length > previewLines
        ? [
            ...all.slice(0, previewLines),
            truncateToWidth(
              expandHint(theme, `… +${all.length - previewLines} lines`),
              width,
              "...",
            ),
          ]
        : all;
    },
    () => text.invalidate(),
  );
};
