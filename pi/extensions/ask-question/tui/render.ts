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

const excerpt = (label: string, text: string, width: number): string => {
  const [first, ...rest] = displayText(text).split("\n");

  return truncateToWidth(`${label}${first}${rest.length ? " …" : ""}`, width, "…");
};

/** Appended to options with auxiliary details, so `p` is discoverable. */
export const DETAILS_MARK = "  ▸ details (p)";

const hasOptionDetails = (q: Question, index: number): boolean => {
  const option = q.options?.[index];

  return !!(
    option?.description ||
    option?.preview ||
    (option && q.recommendation?.option_ids.includes(option.id))
  );
};

export function optionLines(
  q: Question,
  a: Draft["answers"][string],
  highlight: number,
  width: number,
  theme: Theme,
) {
  const lines: string[] = [];

  const choices = [
    ...(q.options ?? []).map((o, index) => ({
      label: `${index + 1}. ${o.label}${q.recommendation?.option_ids.includes(o.id) ? " ★" : ""}`,
      text: "",
      selected: a.selected.includes(o.id),
      note: a.notes[o.id],
      details: hasOptionDetails(q, index),
    })),
    {
      label: q.options?.length ? "Write another answer" : "Write your answer",
      text: a.custom,
      selected: a.custom_selected,
      note: a.custom_note,
      details: false,
    },
  ];

  const inner = Math.max(1, width - 4);

  for (const [index, o] of choices.entries()) {
    const focused = index === highlight;

    const marker = q.multi_select ? (o.selected ? "[x]" : "[ ]") : o.selected ? "(•)" : "( )";
    const rows = textLines(`${focused ? ">" : " "} ${marker} ${o.label}`, width);

    for (const [i, row] of rows.entries()) {
      const suffix = o.details && i === rows.length - 1 ? DETAILS_MARK : "";
      const styled = theme.fg(o.selected ? "success" : "text", row) + theme.fg("accent", suffix);
      const used = visibleWidth(row) + visibleWidth(suffix);
      lines.push(
        focused ? theme.bg("selectedBg", styled + " ".repeat(Math.max(0, width - used))) : styled,
      );
    }

    if (o.text) lines.push(theme.fg("muted", `    ${excerpt("", o.text, inner)}`));

    if (o.note) lines.push(theme.fg("muted", `    ${excerpt("Note: ", o.note, inner)}`));
  }

  return lines;
}

/** Full auxiliary content for the highlighted option. */
export function optionDetailText(q: Question, highlight: number): string | undefined {
  const option = q.options?.[highlight];

  if (!option || !hasOptionDetails(q, highlight)) return;
  const sections: string[] = [];

  if (option.description) sections.push(`## Description\n\n${option.description}`);

  if (q.recommendation?.option_ids.includes(option.id))
    sections.push(`## Recommendation\n\n★ ${q.recommendation.reason}`);

  if (option.preview) sections.push(`## Preview\n\n${option.preview}`);

  return sections.join("\n\n");
}

interface FrameOptions {
  title: string;
  header: string;
  footer: string;
  closeKey: string;
  hint: string;
  rows: number;
  width: number;
  scroll: number;
  theme: Theme;
}

interface FrameResult {
  lines: string[];
  scroll: number;
  viewport: { top: number; rows: number };
}

const frameChrome = (options: FrameOptions) => {
  const { width, theme } = options;

  const rule = (label = "", tone: "borderAccent" | "borderMuted" = "borderAccent") => {
    const text = label ? truncateToWidth(`─ ${oneLine(label)} `, width, "… ") : "";

    return theme.fg(tone, text + "─".repeat(Math.max(0, width - visibleWidth(text))));
  };

  const footer = [...options.footer.split("\n"), ""]
    .slice(0, 2)
    .map((line) => truncateToWidth(displayText(line), width, "…"));

  const maxBudget = Math.max(3, options.rows - 2);
  const normalBudget = Math.max(8, Math.min(Math.floor(options.rows * 0.6), maxBudget));

  return { footer, maxBudget, normalBudget, rule };
};

const tooSmall = (options: FrameOptions): FrameResult => ({
  scroll: options.scroll,
  viewport: { top: 0, rows: 0 },
  lines: textLines(
    `Terminal too small for the questionnaire · ${options.closeKey} closes and keeps the draft`,
    options.width,
  ).slice(0, Math.max(3, options.rows - 2)),
});

const finishFrame = (
  options: FrameOptions,
  body: string[],
  scroll: number,
  viewportRows: number,
  hint: string,
): FrameResult => {
  const { footer, rule } = frameChrome(options);

  return {
    scroll,
    viewport: { top: 3, rows: viewportRows },
    lines: [
      rule(options.title),
      options.header,
      "",
      ...body,
      options.theme.fg(
        options.hint ? "warning" : "dim",
        truncateToWidth(displayText(hint), options.width),
      ),
      ...footer.map((line) => options.theme.fg("dim", line)),
      rule(),
    ].map((line) => truncateToWidth(line, options.width)),
  };
};

/** Render scrollable context above compact, always-visible answer controls. */
export function renderQuestionView(
  options: FrameOptions & { context: string[]; answers: string[] },
): FrameResult {
  const { footer, maxBudget, normalBudget, rule } = frameChrome(options);

  if (options.width < 24 || maxBudget < 8) return tooSmall(options);
  const chromeRows = footer.length + 5;
  const dividerRows = options.context.length > 0 ? 1 : 0;
  const minimumContextRows = options.context.length > 0 ? 1 : 0;
  const required = chromeRows + options.answers.length + dividerRows + minimumContextRows;

  if (required > maxBudget) return tooSmall(options);
  const normalContextRows = normalBudget - chromeRows - options.answers.length - dividerRows;

  const contextRows = Math.min(
    options.context.length,
    Math.max(minimumContextRows, normalContextRows),
    8,
  );

  const scroll = Math.max(
    0,
    Math.min(options.scroll, Math.max(0, options.context.length - contextRows)),
  );

  const visibleContext = options.context.slice(scroll, scroll + contextRows);

  const divider =
    options.context.length > 0
      ? [
          rule(
            options.context.length > contextRows
              ? `Context ${scroll + 1}–${Math.min(scroll + contextRows, options.context.length)} / ${options.context.length}`
              : "Context",
            "borderMuted",
          ),
        ]
      : [];

  const hint =
    options.hint ||
    (options.context.length > contextRows ? "Scroll context with PageUp/PageDown" : "");

  return finishFrame(
    options,
    [...visibleContext, ...divider, ...options.answers],
    scroll,
    contextRows,
    hint,
  );
}

/** Render Review, editors, previews and metadata as conventional scrolling pages. */
export function renderScrollablePage(
  options: FrameOptions & { body: string[]; focusLine?: number },
): FrameResult {
  const { footer, normalBudget } = frameChrome(options);

  if (options.width < 24 || normalBudget < 8) return tooSmall(options);
  const capacity = normalBudget - footer.length - 5;

  if (capacity < 1) return tooSmall(options);
  const viewportRows = Math.max(1, Math.min(capacity, options.body.length || 1));

  let scroll = Math.max(
    0,
    Math.min(options.scroll, Math.max(0, options.body.length - viewportRows)),
  );

  if (options.focusLine !== undefined) {
    if (options.focusLine < scroll) scroll = options.focusLine;
    else if (options.focusLine >= scroll + viewportRows)
      scroll = options.focusLine - viewportRows + 1;
  }

  const visible = options.body.slice(scroll, scroll + viewportRows);

  const hint =
    options.hint ||
    (options.body.length > viewportRows
      ? `${scroll + 1}–${Math.min(scroll + viewportRows, options.body.length)} / ${options.body.length} · scroll`
      : "");

  return finishFrame(options, visible, scroll, viewportRows, hint);
}
