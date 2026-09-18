import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DocumentAdapter } from "./adapter.js";

export interface Decoration {
  start: number;
  end: number;
  foreground?: "accent";
  selected?: boolean;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Zero-width terminal sequences: CSI styles, and APC/OSC strings ended by BEL or ST. A focused
// editor emits Pi's cursor marker, the BEL-terminated APC "\x1b_pi:c\x07", on the cursor's row.
// oxlint-disable-next-line no-control-regex
const escapes = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b[_\]][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function decorateRows(
  rows: string[],
  text: string,
  padding: number,
  adapter: DocumentAdapter,
  spans: Decoration[],
  theme: Theme,
  width: number,
): string[] {
  const layout = adapter.layout();
  const offsets = [0];

  for (const line of text.split("\n")) offsets.push(offsets.at(-1)! + line.length + 1);

  return rows.map((row, index) => {
    if (index < 1 || index > layout.visible) return truncateToWidth(row, width, "");
    const map = layout.rows[layout.scroll + index - 1]!;
    let position = -padding;

    const result = row
      .split(escapes)
      .map((part) => {
        if (part.startsWith("\x1b")) return part;

        return [...segmenter.segment(part)]
          .map(({ segment }) => {
            const offset = offsets[map.logicalLine]! + map.startCol + position;

            const inside =
              position >= 0 &&
              (position < map.length ||
                (position === map.length && (map.length === 0 || text[offset] === "\n")));

            position += segment.length;

            if (!inside) return segment;
            const active = spans.filter((span) => offset >= span.start && offset < span.end);
            let output = segment;

            if (active.some((span) => span.foreground === "accent"))
              output = theme.fg("accent", output);

            if (active.some((span) => span.selected)) output = theme.bg("selectedBg", output);

            return output;
          })
          .join("");
      })
      .join("");

    return truncateToWidth(result, width, "");
  });
}
