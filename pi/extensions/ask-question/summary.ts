import type { Answer, Draft, Interaction, Submission } from "./interaction.js";
import { submissionChanges } from "./interaction.js";
import type { Question } from "./request.js";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";

/** One structured line of a reviewed submission, shared by the TUI, the transcript and tool results. */
export type Row =
  | { kind: "changed"; headers: string[] }
  | { kind: "question"; index: number; header: string }
  | { kind: "answer"; text: string; note?: string }
  | { kind: "missing" }
  | { kind: "note"; text: string };

export function answered(a: Draft["answers"][string] | undefined): boolean {
  return (
    a !== undefined &&
    (a.selected.length > 0 || a.custom_selected) &&
    (!a.custom_selected || !!displayText(a.custom).trim())
  );
}

/** The draft's current answer in submission shape; a blank custom answer is shown as required. */
export function draftAnswer(item: Interaction, q: Question): Answer {
  const answer: Answer = { question: q.question, header: q.header, selections: [] };
  const a = item.draft?.answers[q.id];

  if (!a) return answer;

  for (const id of a.selected) {
    const selection: Answer["selections"][number] = {
      option_id: id,
      label: q.options?.find((o) => o.id === id)?.label ?? id,
    };

    if (a.notes[id]) selection.note = a.notes[id];
    answer.selections.push(selection);
  }

  if (a.custom_selected) {
    answer.custom = { text: displayText(a.custom).trim() ? a.custom : "(blank — required)" };

    if (a.custom_note) answer.custom.note = a.custom_note;
  }

  return answer;
}

export function answerRows(answer: Answer | undefined): Row[] {
  const rows: Row[] = [];

  for (const s of answer?.selections ?? [])
    rows.push({ kind: "answer", text: s.label, ...(s.note !== undefined ? { note: s.note } : {}) });

  if (answer?.custom)
    rows.push({
      kind: "answer",
      text: answer.custom.text,
      ...(answer.custom.note !== undefined ? { note: answer.custom.note } : {}),
    });

  return rows.length ? rows : [{ kind: "missing" }];
}

export function submissionRows(
  answers: Record<string, Answer>,
  note: string,
  changed?: string[],
): Row[] {
  const rows: Row[] = [];

  if (changed) rows.push({ kind: "changed", headers: changed });
  Object.values(answers).forEach((answer, index) =>
    rows.push({ kind: "question", index, header: answer.header }, ...answerRows(answer)),
  );

  if (note) rows.push({ kind: "note", text: note });

  return rows;
}

export function draftChanges(item: Interaction): string[] {
  const previous = item.submissions.at(-1);

  if (!previous || !item.draft) return [];

  const changes = item.request.questions
    .filter(
      (q) =>
        JSON.stringify(answerRows(draftAnswer(item, q))) !==
        JSON.stringify(answerRows(previous.answers[q.id])),
    )
    .map((q) => q.header);

  if (previous.note !== item.draft.note) changes.push("Questionnaire note");

  return changes;
}

/** Rows for a submission, or for the current draft when no submission is given. */
export function interactionRows(item: Interaction, submission?: Submission): Row[] {
  if (submission)
    return submissionRows(
      submission.answers,
      submission.note,
      submission.parent_revision ? submissionChanges(item, submission) : undefined,
    );

  const answers = Object.fromEntries(
    item.request.questions.map((q) => [q.id, draftAnswer(item, q)]),
  );

  return submissionRows(
    answers,
    item.draft?.note ?? "",
    item.draft?.base_revision ? draftChanges(item) : undefined,
  );
}

const indent = (text: string, first: string, rest: string): string =>
  displayText(text)
    .split("\n")
    .map((line, i) => (i ? rest : first) + line)
    .join("\n");

export function plainText(rows: Row[]): string {
  const lines: string[] = [];

  for (const row of rows)
    switch (row.kind) {
      case "changed":
        lines.push(`Changed: ${row.headers.join(", ") || "No answer changes"}`, "");
        break;
      case "question":
        if (lines.length && lines.at(-1) !== "") lines.push("");
        lines.push(`${row.index + 1}. ${row.header}`);
        break;
      case "answer":
        lines.push(indent(`✓ ${row.text}`, "  ", "    "));

        if (row.note) lines.push(indent(`Note: ${row.note}`, "    ", "    "));
        break;
      case "missing":
        lines.push("  ○ Answer required");
        break;
      case "note":
        lines.push("", "Questionnaire note:", displayText(row.text));
        break;
    }

  return lines.join("\n");
}

/** Backslash-escape every ASCII punctuation character so user text never becomes Markdown structure. */
export const escapeMarkdown = (text: string): string =>
  displayText(text).replace(/[!-/:-@[-`{-~]/g, "\\$&");

/** Markdown with hard line breaks; user text stays literal and multi-line text keeps its lines. */
export function markdownText(heading: string, rows: Row[]): string {
  const blocks: string[] = [heading];
  const items: string[] = [];
  let item: string[] | undefined;
  const literal = (text: string) => escapeMarkdown(text).split("\n").join("\\\n   ");

  const flush = () => {
    if (item) items.push(item.join("\\\n   "));
    item = undefined;
  };

  for (const row of rows)
    switch (row.kind) {
      case "changed":
        blocks.push(
          `Changed: ${row.headers.map(escapeMarkdown).join(", ") || "No answer changes"}`,
        );
        break;
      case "question":
        flush();
        item = [`${row.index + 1}. **${escapeMarkdown(row.header)}**`];
        break;
      case "answer":
        item?.push(`✓ ${literal(row.text)}`);

        if (row.note) item?.push(`Note: ${literal(row.note)}`);
        break;
      case "missing":
        item?.push("○ Answer required");
        break;
      case "note":
        flush();

        if (items.length) blocks.push(items.splice(0).join("\n"));
        blocks.push(
          `**Questionnaire note**\\\n${escapeMarkdown(row.text).split("\n").join("\\\n")}`,
        );
        break;
    }

  flush();

  if (items.length) blocks.push(items.join("\n"));

  return blocks.join("\n\n");
}
