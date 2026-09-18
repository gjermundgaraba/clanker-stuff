import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Question } from "../request.js";
import type { Draft, Interaction, Submission } from "../interaction.js";
import { answerRows, answered, draftAnswer, interactionRows, plainText } from "../summary.js";

const oneLine = (text: string) => displayText(text).replace(/\s+/g, " ");

export function progressLine(
  item: Interaction,
  current: number,
  width: number,
  theme: Theme,
): string {
  const questions = item.request.questions;

  const labels = [
    ...questions.map((q) => {
      const complete = !!item.draft && answered(item.draft.answers[q.id]);

      return { text: `${complete ? "✓" : "○"} ${oneLine(q.header)}`, complete };
    }),
    {
      text: "Review",
      complete: !!item.draft && Object.values(item.draft.answers).every(answered),
    },
  ];

  const chip = (label: (typeof labels)[number], i: number) =>
    i === current
      ? theme.bg("selectedBg", theme.bold(` ${label.text} `))
      : theme.fg(label.complete ? "success" : "muted", ` ${label.text} `);

  const all = labels.map(chip).join(" ");

  if (visibleWidth(all) <= width) return all;
  const prefix = current < questions.length ? `${current + 1}/${questions.length} · ` : "";

  const active = labels[current];

  if (!active) throw new RangeError("Questionnaire progress index is out of range");

  return truncateToWidth(`${prefix}${chip(active, current)}`, width);
}

export function inboxLabel(item: Interaction, index: number): string {
  const latest = item.submissions.at(-1);

  const status = item.draft
    ? `${Object.values(item.draft.answers).filter(answered).length}/${item.request.questions.length} answered · Draft${item.paused ? " · Paused" : ""}`
    : latest
      ? `Revision ${latest.revision} · ${deliveryLabel(item.deliveries.at(-1)?.status)}`
      : "Cancelled";

  // The request decoder requires at least one question, including during journal replay.
  return `${index + 1}. ${oneLine(item.request.title ?? item.request.questions[0]!.header)} · ${status}`;
}

export function deliveryLabel(
  status: Interaction["deliveries"][number]["status"] | undefined,
): string {
  switch (status) {
    case "delivered":
      return "Sent";
    case "handed_to_pi":
      return "Queued in Pi";
    case "uncertain":
      return "Delivery unconfirmed";
    default:
      return "Not sent";
  }
}

export function reviewText(item: Interaction, submission?: Submission): string {
  return plainText(interactionRows(item, submission));
}

export function diffText(item: Interaction): string {
  const previous = item.submissions.at(-1);

  if (!previous || !item.draft) return "No earlier submission";
  const lines: string[] = [];

  for (const q of item.request.questions) {
    const before = plainText(answerRows(previous.answers[q.id]));
    const after = plainText(answerRows(draftAnswer(item, q)));

    if (before !== after)
      lines.push(
        q.header,
        `Before · revision ${previous.revision}`,
        before,
        "After · draft",
        after,
        "",
      );
  }

  if (previous.note !== item.draft.note)
    lines.push(
      "Questionnaire note",
      `Before: ${previous.note || "(none)"}`,
      `After: ${item.draft.note || "(none)"}`,
    );

  return lines.join("\n").trimEnd() || "No answer changes";
}

export function markdownLines(text: string, width: number): string[] {
  return new Markdown(displayText(text), 0, 0, getMarkdownTheme()).render(Math.max(1, width));
}

/** Wrapped, unpadded lines. */
export function textLines(text: string, width: number): string[] {
  return wrapTextWithAnsi(displayText(text), Math.max(1, width));
}

export interface InlineEditor {
  /** Choice index the editor belongs to: an option index, the custom row, or -1 for the questionnaire note. */
  choice: number;
  lines: string[];
}

const excerpt = (label: string, text: string, width: number): string => {
  const [first, ...rest] = displayText(text).split("\n");

  return truncateToWidth(`${label}${first}${rest.length ? " …" : ""}`, width, "…");
};

/** Appended to options that carry a Markdown preview, so `p` is discoverable. */
export const PREVIEW_MARK = "  ▸ preview (p)";

export function optionLines(
  q: Question,
  a: Draft["answers"][string],
  highlight: number,
  width: number,
  theme: Theme,
  inline?: InlineEditor,
) {
  const lines: string[] = [];
  let focusLine = 0;
  let focusEnd = 0;

  const choices = [
    ...(q.options ?? []).map((o, index) => ({
      label: `${index + 1}. ${o.label}${q.recommendation?.option_ids.includes(o.id) ? " ★" : ""}`,
      text: "",
      selected: a.selected.includes(o.id),
      note: a.notes[o.id],
      preview: !!o.preview,
    })),
    {
      label: q.options?.length ? "Write another answer" : "Write your answer",
      text: a.custom,
      selected: a.custom_selected,
      note: a.custom_note,
      preview: false,
    },
  ];

  const inner = Math.max(1, width - 4);

  for (const [index, o] of choices.entries()) {
    const focused = index === highlight;

    if (focused) focusLine = lines.length;
    const marker = q.multi_select ? (o.selected ? "[x]" : "[ ]") : o.selected ? "(•)" : "( )";
    const rows = textLines(`${focused ? ">" : " "} ${marker} ${o.label}`, width);

    for (const [i, row] of rows.entries()) {
      const suffix = o.preview && i === rows.length - 1 ? PREVIEW_MARK : "";
      const styled = theme.fg(o.selected ? "success" : "text", row) + theme.fg("accent", suffix);
      const used = visibleWidth(row) + visibleWidth(suffix);
      lines.push(
        focused ? theme.bg("selectedBg", styled + " ".repeat(Math.max(0, width - used))) : styled,
      );
    }

    if (inline?.choice === index) lines.push(...inline.lines.map((line) => `    ${line}`));
    else {
      if (o.text) lines.push(theme.fg("muted", `    ${excerpt("", o.text, inner)}`));

      if (o.note) lines.push(theme.fg("muted", `    ${excerpt("Note: ", o.note, inner)}`));
    }

    if (focused) focusEnd = lines.length - 1;
  }

  return { lines, focusLine, focusEnd };
}

/** What the highlighted choice means: its description, recommendation or written text. */
export function detailLines(
  q: Question,
  a: Draft["answers"][string],
  highlight: number,
  width: number,
  theme: Theme,
): string[] {
  const option = q.options?.[highlight];

  const parts = option
    ? [
        option.description,
        q.recommendation?.option_ids.includes(option.id)
          ? `★ Recommended: ${q.recommendation.reason}`
          : undefined,
      ]
    : [a.custom || "Enter your own response"];

  const text = parts.filter(Boolean).join("\n");

  if (!text && !option?.preview) return [];

  return [
    "",
    theme.bold("Details"),
    ...textLines(text, width).map((l) => theme.fg("muted", l)),
    ...(option?.preview ? [theme.fg("accent", "▸ Markdown preview available · p")] : []),
  ];
}

/**
 * A full-width frame between two accent rules, at most ~60% of the terminal high.
 * `minBody` keeps the height stable across views that are shorter than the tallest one.
 */
export function boundedView(options: {
  title: string;
  header: string;
  body: string[];
  footer: string;
  closeKey: string;
  hint: string;
  rows: number;
  width: number;
  scroll: number;
  minBody?: number;
  focusLine?: number;
  focusEnd?: number;
  theme: Theme;
}) {
  const { width, theme } = options;

  const rule = (label = "") => {
    const text = label ? truncateToWidth(`─ ${oneLine(label)} `, width, "… ") : "";

    return theme.fg("borderAccent", text + "─".repeat(Math.max(0, width - visibleWidth(text))));
  };

  const budget = Math.max(3, Math.min(Math.floor(options.rows * 0.6), options.rows - 2));

  if (width < 24 || budget < 8)
    return {
      scroll: options.scroll,
      bodyRows: 0,
      lines: textLines(
        `Terminal too small for the questionnaire · ${options.closeKey} closes and keeps the draft`,
        width,
      ).slice(0, budget),
    };

  // Always two truncated footer lines, so the frame height never depends on the view.
  const footer = [...options.footer.split("\n"), ""]
    .slice(0, 2)
    .map((line) => truncateToWidth(displayText(line), width, "…"));

  const size = Math.max(
    1,
    Math.min(budget - footer.length - 5, Math.max(options.body.length, options.minBody ?? 0)),
  );

  let scroll = options.scroll;

  if (options.focusLine !== undefined) {
    if (options.focusLine < scroll) scroll = options.focusLine;
    else {
      const end = Math.min(options.focusEnd ?? options.focusLine, options.focusLine + size - 1);

      if (end >= scroll + size) scroll = end - size + 1;
    }
  }

  scroll = Math.max(0, Math.min(scroll, Math.max(0, options.body.length - size)));
  const body = options.body.slice(scroll, scroll + size);

  const hint =
    options.hint ||
    (options.body.length > size
      ? `${scroll + 1}–${Math.min(scroll + size, options.body.length)} / ${options.body.length} · scroll`
      : "");

  return {
    scroll,
    bodyRows: size,
    lines: [
      rule(options.title),
      options.header,
      "",
      ...body,
      ...Array.from({ length: size - body.length }, () => ""),
      theme.fg(options.hint ? "warning" : "dim", truncateToWidth(displayText(hint), width)),
      ...footer.map((line) => theme.fg("dim", line)),
      rule(),
    ].map((line) => truncateToWidth(line, width)),
  };
}
