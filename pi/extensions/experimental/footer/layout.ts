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

type Truncation = "start" | "end";

/** A widget rendered to one styled line, keyed by its config ID. */
export interface LiveWidget {
  text: string;
  truncate?: Truncation;
}

export interface FooterLayout {
  lines: string[];
  truncated: string[];
}

/** Single-line status text as Pi's own footer shows it, with styling closed before the next widget. */
export const cleanStatus = (text: string): string => {
  const clean = text
    .replace(/[\r\n\t]/gu, " ")
    .replace(/ +/gu, " ")
    .trim();

  return clean.includes("\u001B") ? `${clean}\u001B[0m` : clean;
};

export const renderBuiltin = (
  widget: BuiltinWidget,
  family: IconFamily,
  theme: FooterTheme,
): string => {
  // Session names, paths and model IDs come from saved sessions and providers; keep their controls off the screen.
  const spans = widget.content.map(({ text, tone }) => ({ text: inlineText(text), tone }));

  if (spans.every(({ text }) => text.length === 0)) return "";

  const icon = widget.icon === undefined ? "" : `${theme.fg("dim", widget.icon[family])} `;

  return icon + spans.map(({ text, tone }) => theme.fg(tone, text)).join("");
};

/** Statuses keyed `status:<key>`, ready to place. */
export const statusWidgets = (statuses: ReadonlyMap<string, string>): Map<string, LiveWidget> =>
  new Map(
    [...statuses]
      .map(([key, text]): [string, LiveWidget] => [
        `${STATUS_PREFIX}${key}`,
        { text: cleanStatus(text) },
      ])
      .filter(([, widget]) => widget.text.length > 0),
  );

const truncate = (text: string, width: number, direction: Truncation): string => {
  const sourceWidth = visibleWidth(text);

  if (sourceWidth <= width) return text;

  if (width <= 0) return "";

  return direction === "end"
    ? truncateToWidth(text, width, "…")
    : `…${sliceByColumn(text, sourceWidth - (width - 1), width - 1, true)}`;
};

/** Capped equal allocation: narrow widgets keep their width, wide ones share the rest. */
const allocateWidths = (widths: readonly number[], budget: number): number[] => {
  if (widths.reduce((total, width) => total + width, 0) <= budget) return [...widths];

  let low = 0;
  let high = Math.max(0, ...widths);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (widths.reduce((total, width) => total + Math.min(width, middle), 0) <= budget) low = middle;
    else high = middle - 1;
  }

  const allocated = widths.map((width) => Math.min(width, low));
  let remaining = budget - allocated.reduce((total, width) => total + width, 0);

  for (let index = 0; index < widths.length && remaining > 0; index += 1) {
    if ((allocated[index] ?? 0) < (widths[index] ?? 0)) {
      allocated[index] = (allocated[index] ?? 0) + 1;
      remaining -= 1;
    }
  }

  return allocated;
};

interface Placed extends LiveWidget {
  id: string;
  side: "left" | "right";
}

const fitRow = (
  items: readonly Placed[],
  width: number,
  separator: string,
): { line: string; truncated: string[] } => {
  const count = (side: Placed["side"]) => items.filter((item) => item.side === side).length;
  const left = count("left");
  const right = count("right");
  const gap = left > 0 && right > 0 ? 1 : 0;
  const fixed = (Math.max(0, left - 1) + Math.max(0, right - 1)) * visibleWidth(separator) + gap;
  const natural = items.map((item) => visibleWidth(item.text));
  const budgets = allocateWidths(natural, Math.max(0, width - fixed));

  const fitted = items.map((item, index) =>
    truncate(
      item.text,
      budgets[index] ?? 0,
      item.truncate ?? (item.side === "left" ? "end" : "start"),
    ),
  );

  const join = (side: Placed["side"]) =>
    fitted.filter((text, index) => items[index]?.side === side && text.length > 0).join(separator);

  const leftText = join("left");
  const rightText = join("right");

  const padding =
    rightText.length === 0
      ? 0
      : Math.max(gap, width - visibleWidth(leftText) - visibleWidth(rightText));

  return {
    line: truncateToWidth(`${leftText}${" ".repeat(padding)}${rightText}`, width, ""),
    truncated: items
      .filter((_item, index) => (budgets[index] ?? 0) < (natural[index] ?? 0))
      .map(({ id }) => id),
  };
};

export const layoutFooter = (
  config: FooterConfig,
  live: ReadonlyMap<string, LiveWidget>,
  width: number,
  theme: FooterTheme,
): FooterLayout => {
  const safeWidth = Math.max(0, Math.floor(width));
  // Hidden statuses can appear only here, so skipping them here hides them everywhere.
  const claimed = new Set([...placedIds(config), ...config.hidden]);

  const expand = (id: string): [string, LiveWidget][] => {
    if (id !== STATUSES_ID) {
      const widget = live.get(id);

      return widget === undefined ? [] : [[id, widget]];
    }

    return [...live]
      .filter(([member]) => member.startsWith(STATUS_PREFIX) && !claimed.has(member))
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
        .map(([id, widget]): Placed => ({ ...widget, id, side })),
    );

    if (items.length === 0 || safeWidth === 0) continue;

    const fitted = fitRow(items, safeWidth, separator);
    lines.push(fitted.line);
    truncated.push(...fitted.truncated);
  }

  return { lines, truncated };
};

/**
 * Replaces only trailing rule cells of Pi's editor top border, so labels, the working status
 * and the input width stay intact. Entries keep their order; one that does not fit is skipped.
 */
export const renderBorder = (
  original: string,
  width: number,
  entries: readonly string[],
  theme: FooterTheme,
  borderColor: (text: string) => string,
): string => {
  const plain = stripTerminalSequences(original);

  if (entries.length === 0 || width < 5 || visibleWidth(original) !== width) return original;

  if (!plain.startsWith("─") || !plain.endsWith("─")) return original;

  // Keep two rule cells before the block and one after it, plus the spaces around it.
  const budget = (/─+$/u.exec(plain)?.[0].length ?? 0) - 5;
  const selected: string[] = [];
  let used = 0;

  for (const entry of entries) {
    const size = visibleWidth(entry) + (selected.length > 0 ? 3 : 0);

    if (size > (selected.length > 0 ? 3 : 0) && used + size <= budget) {
      used += size;
      selected.push(entry);
    }
  }

  if (selected.length === 0) return original;

  return `${sliceByColumn(original, 0, width - used - 3, true)}\u001B[0m${borderColor(" ")}${selected.join(theme.fg("dim", " · "))}${borderColor(" ─")}`;
};
