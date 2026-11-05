import type { Theme } from "@earendil-works/pi-coding-agent";

import type { Layout } from "./adapter.js";

/** A range of the editor text, in UTF-16 offsets, painted in the accent color. */
export interface Highlight {
  start: number;
  end: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const escapes =
  // oxlint-disable-next-line no-control-regex -- The pattern matches terminal control sequences, which begin with ESC and may end with BEL.
  /(?<escape>\u001B\[[0-?]*[ -/]*[@-~]|\u001B[_\]][^\u0007\u001B]*(?:\u0007|\u001B\\))/gu;

export const highlightRows = (
  rows: string[],
  text: string,
  padding: number,
  layout: Layout,
  highlights: Highlight[],
  theme: Theme
): string[] => {
  const offsets = [0];
  let lineEnd = 0;

  for (const line of text.split("\n")) {
    lineEnd += line.length + 1;
    offsets.push(lineEnd);
  }

  return rows.map((row, index) => {
    if (index < 1 || index > layout.visible) {
      return row;
    }

    const map = layout.rows[layout.scroll + index - 1];

    if (map === undefined) {
      throw new Error(
        `Editor layout has no visual line for rendered row ${index}`
      );
    }

    const lineStart = offsets[map.logicalLine];

    if (lineStart === undefined) {
      throw new Error(
        `Editor layout maps row ${index} to missing logical line ${map.logicalLine}`
      );
    }

    let position = -padding;

    return row
      .split(escapes)
      .map((part) => {
        if (part.startsWith("\u001B")) {
          return part;
        }

        return [...segmenter.segment(part)]
          .map(({ segment }) => {
            const offset = lineStart + map.startCol + position;
            const inside = position >= 0 && position < map.length;
            position += segment.length;

            const highlighted =
              inside &&
              highlights.some(
                (range) => offset >= range.start && offset < range.end
              );

            return highlighted ? theme.fg("accent", segment) : segment;
          })
          .join("");
      })
      .join("");
  });
};
