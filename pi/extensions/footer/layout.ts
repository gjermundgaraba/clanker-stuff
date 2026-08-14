/* oxlint-disable eslint/complexity, eslint/no-control-regex, eslint/no-nested-ternary, typescript/no-non-null-assertion -- bounded layout and terminal sanitizing are clearer as direct state machines */

import type {
  FooterContent,
  FooterIconFamily,
  FooterSpan,
  FooterTone,
  FooterTruncation,
  FooterWidgetIcon,
} from "@clanker-stuff/footer-protocol";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { hasTerminalControl } from "./config.js";
import type { FooterConfig } from "./config.js";
import type { LiveWidget } from "./widgets.js";

export interface RenderableWidget {
  id: string;
  group: "left" | "center" | "right";
  text: string;
  truncate?: FooterTruncation;
}

export interface FooterLayoutDecision {
  id: string;
  outcome: "visible" | "truncated";
  reason: string;
}

export interface FooterWidgetRenderError {
  id: string;
  message: string;
}

export interface FooterLayoutResult {
  lines: string[];
  decisions: FooterLayoutDecision[];
  consumedStatusIds: string[];
  duplicates: string[];
  widgetErrors: FooterWidgetRenderError[];
}

export interface FooterRenderState {
  builtins: ReadonlyMap<string, LiveWidget>;
  rich: ReadonlyMap<string, LiveWidget>;
  config: FooterConfig;
  nativeStatuses: ReadonlyMap<string, string>;
}

export type FooterTheme = Pick<Theme, "bold" | "fg">;

const GROUPS: RenderableWidget["group"][] = ["left", "center", "right"];
const SGR_PATTERN = /^\u001B\[[0-9;]*m/u;

interface FittedWidget extends RenderableWidget {
  rendered: string;
}

interface RenderedGroup {
  text: string;
  width: number;
}

export interface PreparedFooter {
  rows: RenderableWidget[][];
  consumedStatusIds: string[];
  duplicates: string[];
  widgetErrors: FooterWidgetRenderError[];
}

const widthOf = (value: string): number => visibleWidth(value);

const sanitizePlainText = (value: string): string => {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    result +=
      code === 0x0a || code === 0x0d
        ? " "
        : code < 0x20 || (code >= 0x7f && code <= 0x9f)
          ? ""
          : char;
  }
  return result;
};

export const sanitizeNativeStatus = (value: string): string => {
  let result = "";
  let index = 0;
  let sawSgr = false;
  while (index < value.length) {
    const rest = value.slice(index);
    const sgr = SGR_PATTERN.exec(rest)?.[0];
    if (sgr !== undefined) {
      result += sgr;
      sawSgr = true;
      index += sgr.length;
      continue;
    }

    const code = value.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    if (code === 0x1b) {
      index += 1;
      if (value[index] === "]") {
        index += 1;
        while (index < value.length) {
          if (value.codePointAt(index) === 0x07) {
            index += 1;
            break;
          }
          if (value.codePointAt(index) === 0x1b && value[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
      } else if (value[index] === "[") {
        index += 1;
        while (
          index < value.length &&
          (value.codePointAt(index) ?? 0) >= 0x20 &&
          (value.codePointAt(index) ?? 0) <= 0x3f
        ) {
          index += 1;
        }
        if (index < value.length) {
          index += 1;
        }
      } else if (index < value.length) {
        index += 1;
      }
      continue;
    }
    result +=
      code === 0x0a || code === 0x0d
        ? " "
        : code < 0x20 || (code >= 0x7f && code <= 0x9f)
          ? ""
          : char;
    index += char.length;
  }
  const sanitized = result.trim();
  return sawSgr && sanitized.length > 0 && !sanitized.endsWith("\u001B[0m")
    ? `${sanitized}\u001B[0m`
    : sanitized;
};

const renderSpan = (span: FooterSpan, theme: FooterTheme): string => {
  const tone: FooterTone = span.tone ?? "text";
  const text = theme.fg(tone, sanitizePlainText(span.text));
  return span.bold === true ? theme.bold(text) : text;
};

const renderContent = (content: FooterContent, theme: FooterTheme): string =>
  content.map((span) => renderSpan(span, theme)).join("");

const iconGlyph = (
  icon: FooterWidgetIcon,
  family: FooterIconFamily
): string => {
  if (typeof icon.glyphs === "string") {
    return icon.glyphs;
  }
  const order: FooterIconFamily[] =
    family === "nerd"
      ? ["nerd", "unicode", "ascii"]
      : family === "unicode"
        ? ["unicode", "ascii"]
        : ["ascii"];
  for (const candidate of order) {
    const glyph = icon.glyphs[candidate];
    if (glyph !== undefined) {
      return glyph;
    }
  }
  return "";
};

const renderLiveWidget = (
  widget: LiveWidget,
  family: FooterIconFamily,
  theme: FooterTheme
): string => {
  if (widget.nativeAnsi === true) {
    return sanitizeNativeStatus(
      widget.snapshot.content.map((span) => span.text).join("")
    );
  }

  const widgetIcon =
    widget.snapshot.icon === false ? undefined : widget.snapshot.icon;
  const icon = widgetIcon
    ? sanitizePlainText(iconGlyph(widgetIcon, family))
    : "";
  const renderedIcon =
    icon.length === 0 ? "" : `${theme.fg(widgetIcon?.tone ?? "dim", icon)} `;
  const health =
    widget.snapshot.health?.state === "stale"
      ? ` ${theme.fg("warning", "!")}`
      : widget.snapshot.health?.state === "error"
        ? ` ${theme.fg("error", "!")}`
        : "";
  const body = renderContent(widget.snapshot.content, theme);
  return body.length === 0 ? "" : `${renderedIcon}${body}${health}`;
};

const isEnabled = (
  widget: LiveWidget,
  state: FooterRenderState,
  aggregateId?: string
): boolean => {
  const aggregate =
    aggregateId === undefined ? undefined : state.config.widgets[aggregateId];
  return (
    state.config.widgets[widget.snapshot.id]?.enabled ??
    aggregate?.enabled ??
    widget.snapshot.defaults?.enabled ??
    true
  );
};

const nativeWidgets = (
  statuses: ReadonlyMap<string, string>
): Map<string, LiveWidget> => {
  const widgets = new Map<string, LiveWidget>();
  for (const [key, raw] of statuses) {
    if (hasTerminalControl(key)) {
      continue;
    }
    const text = sanitizeNativeStatus(raw);
    if (widthOf(text) === 0) {
      continue;
    }
    const id = `status:${key}`;
    widgets.set(id, {
      nativeAnsi: true,
      snapshot: {
        content: [{ text }],
        id,
        label: key,
      },
      source: "native",
    });
  }
  return widgets;
};

export const prepareFooter = (
  state: FooterRenderState,
  theme: FooterTheme
): PreparedFooter => {
  const native = nativeWidgets(state.nativeStatuses);
  const live = new Map<string, LiveWidget>([
    ...state.builtins,
    ...state.rich,
    ...native,
  ]);
  const explicit = new Set<string>();
  for (const row of state.config.rows) {
    for (const group of GROUPS) {
      for (const id of row[group]) {
        if (id !== "footer.widgets" && id !== "footer.statuses") {
          explicit.add(id);
        }
      }
    }
  }

  const richAggregatePlaced = state.config.rows.some((row) =>
    GROUPS.some((group) => row[group].includes("footer.widgets"))
  );
  const rendered = new Map<string, string | undefined>();
  const widgetErrors: FooterWidgetRenderError[] = [];
  const render = (id: string, widget: LiveWidget): string | undefined => {
    if (rendered.has(id)) {
      return rendered.get(id);
    }
    try {
      const text = renderLiveWidget(widget, state.config.iconFamily, theme);
      rendered.set(id, text);
      return text;
    } catch (error) {
      rendered.set(id, undefined);
      widgetErrors.push({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  const consumedStatuses = new Set<string>();
  for (const [id, widget] of state.rich) {
    const placementEligible = explicit.has(id) || richAggregatePlaced;
    if (
      placementEligible &&
      isEnabled(
        widget,
        state,
        explicit.has(id) ? undefined : "footer.widgets"
      ) &&
      (render(id, widget)?.length ?? 0) > 0
    ) {
      for (const key of widget.snapshot.consumesStatusKeys ?? []) {
        if (!explicit.has(`status:${key}`)) {
          consumedStatuses.add(`status:${key}`);
        }
      }
    }
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const rows: RenderableWidget[][] = [];
  for (const configuredRow of state.config.rows) {
    const row: RenderableWidget[] = [];
    for (const group of GROUPS) {
      for (const configuredId of configuredRow[group]) {
        const members: [string, LiveWidget, string | undefined][] =
          configuredId === "footer.widgets"
            ? [...state.rich]
                .filter(([id]) => !explicit.has(id))
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([id, widget]) => [id, widget, "footer.widgets"])
            : configuredId === "footer.statuses"
              ? [...native]
                  .filter(
                    ([id]) => !explicit.has(id) && !consumedStatuses.has(id)
                  )
                  .toSorted(([left], [right]) => left.localeCompare(right))
                  .map(([id, widget]) => [id, widget, "footer.statuses"])
              : live.has(configuredId)
                ? [[configuredId, live.get(configuredId)!, undefined]]
                : [];

        for (const [id, widget, aggregateId] of members) {
          if (seen.has(id)) {
            duplicates.add(id);
            continue;
          }
          seen.add(id);
          if (!isEnabled(widget, state, aggregateId)) {
            continue;
          }
          const text = render(id, widget);
          if (text === undefined || text.length === 0) {
            continue;
          }
          row.push({
            group,
            id,
            text,
            ...(widget.snapshot.truncate === undefined
              ? {}
              : { truncate: widget.snapshot.truncate }),
          });
        }
      }
    }
    if (row.length > 0) {
      rows.push(row);
    }
  }
  return {
    consumedStatusIds: [...consumedStatuses].toSorted(),
    duplicates: [...duplicates],
    rows,
    widgetErrors,
  };
};

const renderGroup = (
  widgets: readonly FittedWidget[],
  group: RenderableWidget["group"],
  separator: string
): RenderedGroup => {
  const text = widgets
    .filter((widget) => widget.group === group)
    .map((widget) => widget.rendered)
    .join(separator);
  return { text, width: widthOf(text) };
};

const align = (
  widgets: readonly FittedWidget[],
  width: number,
  separator: string,
  groupGap: number
): string => {
  const [left, center, right] = GROUPS.map((group) =>
    renderGroup(widgets, group, separator)
  );

  const hasLeft = left.width > 0;
  const hasCenter = center.width > 0;
  const hasRight = right.width > 0;
  if (!hasCenter) {
    if (!hasRight) {
      return left.text;
    }
    const gap = hasLeft ? groupGap : 0;
    const padding = Math.max(gap, width - left.width - right.width);
    return `${left.text}${" ".repeat(padding)}${right.text}`;
  }

  const leftEnd = left.width;
  const rightStart = width - right.width;
  const minimumCenter = leftEnd + (hasLeft ? groupGap : 0);
  const maximumCenter = rightStart - center.width - (hasRight ? groupGap : 0);
  const centered = Math.floor((width - center.width) / 2);
  const centerStart = Math.max(
    minimumCenter,
    Math.min(centered, maximumCenter)
  );
  let line =
    left.text + " ".repeat(Math.max(0, centerStart - left.width)) + center.text;
  if (hasRight) {
    line +=
      " ".repeat(Math.max(0, rightStart - (centerStart + center.width))) +
      right.text;
  }
  return line;
};

const truncationFor = (widget: RenderableWidget): FooterTruncation =>
  widget.truncate ??
  (widget.group === "left"
    ? "end"
    : widget.group === "right"
      ? "start"
      : "middle");

const truncate = (
  text: string,
  width: number,
  direction: FooterTruncation
): string => {
  const sourceWidth = widthOf(text);
  if (sourceWidth <= width) {
    return text;
  }
  if (width <= 0) {
    return "";
  }
  if (width === 1) {
    return "…";
  }
  const contentWidth = width - 1;
  if (direction === "end") {
    return `${sliceByColumn(text, 0, contentWidth, true)}…`;
  }
  if (direction === "start") {
    return `…${sliceByColumn(
      text,
      Math.max(0, sourceWidth - contentWidth),
      contentWidth,
      true
    )}`;
  }
  const leftWidth = Math.ceil(contentWidth / 2);
  const rightWidth = contentWidth - leftWidth;
  return `${sliceByColumn(text, 0, leftWidth, true)}…${sliceByColumn(
    text,
    Math.max(0, sourceWidth - rightWidth),
    rightWidth,
    true
  )}`;
};

const allocateTextWidths = (
  widths: readonly number[],
  budget: number
): number[] => {
  if (widths.reduce((total, width) => total + width, 0) <= budget) {
    return [...widths];
  }
  let low = 0;
  let high = Math.max(0, ...widths);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const used = widths.reduce(
      (total, width) => total + Math.min(width, middle),
      0
    );
    if (used <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
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

const fitRow = (
  source: readonly RenderableWidget[],
  width: number,
  separator: string
): { decisions: FooterLayoutDecision[]; line: string } => {
  const groupCount = new Set(source.map((widget) => widget.group)).size;
  let internalSeparators = 0;
  for (const group of GROUPS) {
    const members = source.filter((widget) => widget.group === group).length;
    internalSeparators += Math.max(0, members - 1);
  }
  const desiredFixedWidth =
    internalSeparators * widthOf(separator) + Math.max(0, groupCount - 1);
  const originalWidths = source.map((widget) => widthOf(widget.text));
  const preserveSpacing =
    desiredFixedWidth +
      originalWidths.filter((originalWidth) => originalWidth > 0).length <=
    width;
  const fittedSeparator = preserveSpacing ? separator : "";
  const groupGap = preserveSpacing ? 1 : 0;
  const fixedWidth = preserveSpacing ? desiredFixedWidth : 0;
  const budgets = allocateTextWidths(
    originalWidths,
    Math.max(0, width - fixedWidth)
  );
  const widgets: FittedWidget[] = source.map((widget, index) => ({
    ...widget,
    rendered: truncate(widget.text, budgets[index] ?? 0, truncationFor(widget)),
  }));
  const line = truncateToWidth(
    align(widgets, width, fittedSeparator, groupGap),
    width,
    ""
  );
  return {
    decisions: widgets.map((widget, index) => {
      const originalWidth = originalWidths[index] ?? 0;
      const allocated = budgets[index] ?? 0;
      const truncated = allocated < originalWidth;
      return {
        id: widget.id,
        outcome: truncated ? "truncated" : "visible",
        reason: truncated
          ? `${truncationFor(widget)} truncation from ${originalWidth} to ${allocated} columns`
          : "content fit",
      };
    }),
    line,
  };
};

export const layoutFooterRows = (
  rows: readonly (readonly RenderableWidget[])[],
  width: number,
  separator: string
): FooterLayoutResult => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) {
    return {
      consumedStatusIds: [],
      decisions: rows.flatMap((row) =>
        row.map((widget) => ({
          id: widget.id,
          outcome: "truncated" as const,
          reason: "terminal width is zero",
        }))
      ),
      duplicates: [],
      lines: [],
      widgetErrors: [],
    };
  }
  const rendered = rows.map((row) => fitRow(row, safeWidth, separator));
  return {
    consumedStatusIds: [],
    decisions: rendered.flatMap((row) => row.decisions),
    duplicates: [],
    lines: rendered.map((row) => row.line).filter(Boolean),
    widgetErrors: [],
  };
};

export const renderFooterState = (
  state: FooterRenderState,
  width: number,
  theme: FooterTheme
): FooterLayoutResult => {
  const prepared = prepareFooter(state, theme);
  const separator =
    state.config.separator.length === 0
      ? " "
      : ` ${theme.fg("dim", sanitizePlainText(state.config.separator))} `;
  return {
    ...layoutFooterRows(prepared.rows, width, separator),
    consumedStatusIds: prepared.consumedStatusIds,
    duplicates: prepared.duplicates,
    widgetErrors: prepared.widgetErrors,
  };
};
