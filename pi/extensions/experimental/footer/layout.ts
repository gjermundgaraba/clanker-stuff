import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { placedIds, STATUS_PREFIX, STATUSES_ID } from "./config.js";
import type { FooterConfig, IconFamily } from "./config.js";
import type { BuiltinWidget } from "./widgets.js";

export type FooterTheme = Pick<Theme, "fg">;

export interface LiveWidget {
  text: string;
  truncate?: "start";
}

export interface FooterLayout {
  lines: string[];
  truncated: string[];
}

export const cleanStatus = (text: string): string => {
  const clean = text
    .replaceAll(/[\r\n\t]/gu, " ")
    .replaceAll(/ +/gu, " ")
    .trim();

  return clean.includes("\u001B") ? `${clean}\u001B[0m` : clean;
};

export const renderBuiltin = (
  widget: BuiltinWidget,
  family: IconFamily,
  theme: FooterTheme
): string => {
  const spans = widget.content.map(({ text, tone }) => ({
    text: inlineText(text),
    tone,
  }));

  if (spans.every(({ text }) => text.length === 0)) {
    return "";
  }

  const icon =
    widget.icon === undefined ? "" : `${theme.fg("dim", widget.icon[family])} `;

  return icon + spans.map(({ text, tone }) => theme.fg(tone, text)).join("");
};

export const statusWidgets = (
  statuses: ReadonlyMap<string, string>
): Map<string, LiveWidget> =>
  new Map(
    statuses
      .entries()
      .map(([key, text]): [string, LiveWidget] => [
        `${STATUS_PREFIX}${key}`,
        { text: cleanStatus(text) },
      ])
      .filter(([, widget]) => widget.text.length > 0)
  );

const truncate = (
  text: string,
  width: number,
  direction: "start" | "end"
): string => {
  const sourceWidth = visibleWidth(text);

  if (sourceWidth <= width) {
    return text;
  }

  if (width <= 0) {
    return "";
  }

  return direction === "end"
    ? truncateToWidth(text, width, "…")
    : `…${sliceByColumn(text, sourceWidth - (width - 1), width - 1, true)}`;
};

interface Placed extends LiveWidget {
  id: string;
  side: "left" | "right";
}

const allocateWidths = (
  items: readonly Placed[],
  budget: number
): Array<{ item: Placed; natural: number; width: number }> => {
  const allocated = items.map((item) => {
    const natural = visibleWidth(item.text);

    return { item, natural, width: natural };
  });

  if (allocated.reduce((total, { width }) => total + width, 0) <= budget) {
    return allocated;
  }

  let low = 0;
  let high = Math.max(0, ...allocated.map(({ natural }) => natural));

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (
      allocated.reduce(
        (total, { natural }) => total + Math.min(natural, middle),
        0
      ) <= budget
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let remaining = budget;

  for (const entry of allocated) {
    entry.width = Math.min(entry.natural, low);
    remaining -= entry.width;
  }

  for (const entry of allocated) {
    if (remaining === 0) {
      break;
    }

    if (entry.width < entry.natural) {
      entry.width += 1;
      remaining -= 1;
    }
  }

  return allocated;
};

const fitRow = (items: readonly Placed[], width: number, separator: string) => {
  const left = items.filter((item) => item.side === "left").length;
  const right = items.length - left;
  const gap = left > 0 && right > 0 ? 1 : 0;

  const fixed =
    (Math.max(0, left - 1) + Math.max(0, right - 1)) * visibleWidth(separator) +
    gap;

  const fitted = allocateWidths(items, Math.max(0, width - fixed)).map(
    ({ item, natural, width: budget }) => ({
      id: item.id,
      side: item.side,
      text: truncate(
        item.text,
        budget,
        item.truncate ?? (item.side === "left" ? "end" : "start")
      ),
      truncated: budget < natural,
    })
  );

  const join = (side: Placed["side"]) =>
    fitted
      .filter((item) => item.side === side && item.text.length > 0)
      .map(({ text }) => text)
      .join(separator);

  const leftText = join("left");
  const rightText = join("right");

  const padding =
    rightText.length === 0
      ? 0
      : Math.max(gap, width - visibleWidth(leftText) - visibleWidth(rightText));

  return {
    line: truncateToWidth(
      `${leftText}${" ".repeat(padding)}${rightText}`,
      width,
      ""
    ),
    truncated: fitted.filter((item) => item.truncated).map(({ id }) => id),
  };
};

export const layoutFooter = (
  config: FooterConfig,
  live: ReadonlyMap<string, LiveWidget>,
  width: number,
  theme: FooterTheme
): FooterLayout => {
  const safeWidth = Math.max(0, Math.floor(width));
  const claimed = new Set([...placedIds(config), ...config.hidden]);

  const expand = (id: string): Array<[string, LiveWidget]> => {
    if (id !== STATUSES_ID) {
      const widget = live.get(id);

      return widget === undefined ? [] : [[id, widget]];
    }

    return [...live]
      .filter(
        ([member]) => member.startsWith(STATUS_PREFIX) && !claimed.has(member)
      )
      .toSorted(([a], [b]) => a.localeCompare(b));
  };

  const separator = ` ${theme.fg("dim", "·")} `;
  const lines: string[] = [];
  const truncated: string[] = [];

  for (const row of config.rows) {
    const items = (["left", "right"] as const).flatMap((side) =>
      row[side]
        .flatMap(expand)
        .filter(([_id, widget]) => widget.text.length > 0)
        .map(([id, widget]): Placed => ({ ...widget, id, side }))
    );

    if (items.length === 0 || safeWidth === 0) {
      continue;
    }

    const fitted = fitRow(items, safeWidth, separator);
    lines.push(fitted.line);
    truncated.push(...fitted.truncated);
  }

  return { lines, truncated };
};

export const renderBorder = (
  original: string,
  width: number,
  entries: readonly string[],
  theme: FooterTheme,
  borderColor: (text: string) => string
): string => {
  if (entries.length === 0 || width < 5 || visibleWidth(original) !== width) {
    return original;
  }

  const plain = stripTerminalSequences(original);

  if (!plain.startsWith("─") || !plain.endsWith("─")) {
    return original;
  }

  const budget = (/─+$/u.exec(plain)?.[0].length ?? 0) - 5;
  const selected: string[] = [];
  let used = 0;

  for (const entry of entries) {
    const entryWidth = visibleWidth(entry);
    const size = entryWidth + (selected.length > 0 ? 3 : 0);

    if (entryWidth > 0 && used + size <= budget) {
      used += size;
      selected.push(entry);
    }
  }

  if (selected.length === 0) {
    return original;
  }

  return `${sliceByColumn(original, 0, width - used - 3, true)}\u001B[0m${borderColor(" ")}${selected.join(theme.fg("dim", " · "))}${borderColor(" ─")}`;
};
