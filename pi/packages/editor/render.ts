import type { Theme } from "@earendil-works/pi-coding-agent";

import type { DocumentAdapter } from "./adapter.js";

export interface Decoration {
  start: number;
  end: number;
  foreground?: "accent";
  selected?: boolean;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const escapes =
  // oxlint-disable-next-line no-control-regex -- The pattern matches terminal control sequences, which begin with ESC and may end with BEL.
  /(?<escape>\u001B\[[0-?]*[ -/]*[@-~]|\u001B[_\]][^\u0007\u001B]*(?:\u0007|\u001B\\))/gu;

export const decorateRows = (
  rows: string[],
  text: string,
  padding: number,
  layout: ReturnType<DocumentAdapter["layout"]>,
  spans: Decoration[],
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

            const inside =
              position >= 0 &&
              (position < map.length ||
                (position === map.length &&
                  (map.length === 0 || text[offset] === "\n")));

            position += segment.length;

            if (!inside) {
              return segment;
            }

            const active = spans.filter(
              (span) => offset >= span.start && offset < span.end
            );

            let output = segment;

            if (active.some((span) => span.foreground === "accent")) {
              output = theme.fg("accent", output);
            }

            if (active.some((span) => span.selected === true)) {
              output = theme.bg("selectedBg", output);
            }

            return output;
          })
          .join("");
      })
      .join("");
  });
};
