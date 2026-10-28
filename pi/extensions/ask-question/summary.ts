import { displayText } from "@clanker-stuff/pi-tool-rendering/text";

import type { Answer, Interaction, Submission } from "./interaction.js";
import { draftAnswer, revisedSubmission } from "./interaction.js";
import type { Question } from "./request.js";

export type Row =
  | { kind: "changed"; headers: string[] }
  | { kind: "question"; index: number; header: string }
  | { kind: "answer"; text: string; note?: string }
  | { kind: "missing" }
  | { kind: "note"; text: string };

export const answerRows = (answer: Answer | undefined): Row[] => {
  const rows: Row[] = [];

  for (const s of answer?.selections ?? []) {
    rows.push({
      kind: "answer",
      text: s.label,
      ...(s.note === undefined ? {} : { note: s.note }),
    });
  }

  if (answer?.custom) {
    rows.push({
      kind: "answer",
      text: displayText(answer.custom.text).trim()
        ? answer.custom.text
        : "(blank — required)",
      ...(answer.custom.note === undefined ? {} : { note: answer.custom.note }),
    });
  }

  return rows.length ? rows : [{ kind: "missing" }];
};

export const submissionRows = (
  answers: Record<string, Answer>,
  note: string,
  changed?: string[]
): Row[] => {
  const rows: Row[] = [];

  if (changed) {
    rows.push({ kind: "changed", headers: changed });
  }

  for (const [index, answer] of Object.values(answers).entries()) {
    rows.push(
      { kind: "question", index, header: answer.header },
      ...answerRows(answer)
    );
  }

  if (note) {
    rows.push({ kind: "note", text: note });
  }

  return rows;
};

export const changedHeaders = (
  questions: Question[],
  previous: Submission,
  answers: Record<string, Answer | undefined>,
  note: string
): string[] => {
  const changes = questions
    .values()
    .filter(
      (q) =>
        JSON.stringify(answerRows(answers[q.id])) !==
        JSON.stringify(answerRows(previous.answers[q.id]))
    )
    .map((q) => q.header)
    .toArray();

  if (previous.note !== note) {
    changes.push("Questionnaire note");
  }

  return changes;
};

export const submissionChanges = (
  item: Interaction,
  submission: Submission
): string[] | undefined => {
  const previous = item.submissions.find(
    (s) => s.revision === submission.revision - 1
  );

  return previous
    ? changedHeaders(
        item.request.questions,
        previous,
        submission.answers,
        submission.note
      )
    : undefined;
};

export const interactionRows = (
  item: Interaction,
  submission?: Submission
): Row[] => {
  if (submission) {
    return submissionRows(
      submission.answers,
      submission.note,
      submissionChanges(item, submission)
    );
  }

  const { questions } = item.request;

  const answers = Object.fromEntries(
    questions.map((q) => [q.id, draftAnswer(item, q)])
  );

  const note = item.draft?.note ?? "";
  const base = revisedSubmission(item);

  return submissionRows(
    answers,
    note,
    base ? changedHeaders(questions, base, answers, note) : undefined
  );
};

const indent = (text: string, first: string, rest: string): string =>
  displayText(text)
    .split("\n")
    .map((line, i) => (i ? rest : first) + line)
    .join("\n");

export const plainText = (rows: Row[]): string => {
  const lines: string[] = [];

  for (const row of rows) {
    switch (row.kind) {
      case "changed": {
        lines.push(
          `Changed: ${row.headers.join(", ") || "No answer changes"}`,
          ""
        );
        break;
      }

      case "question": {
        if (lines.length && lines.at(-1) !== "") {
          lines.push("");
        }

        lines.push(`${row.index + 1}. ${row.header}`);
        break;
      }

      case "answer": {
        lines.push(indent(`✓ ${row.text}`, "  ", "    "));

        if (row.note !== undefined && row.note !== "") {
          lines.push(indent(`Note: ${row.note}`, "    ", "    "));
        }

        break;
      }

      case "missing": {
        lines.push("  ○ Answer required");
        break;
      }

      case "note": {
        lines.push("", "Questionnaire note:", displayText(row.text));
        break;
      }
    }
  }

  return lines.join("\n");
};

export const escapeMarkdown = (text: string): string =>
  displayText(text).replaceAll(/[!-/:-@[-`{-~]/gu, "\\$&");

const literal = (text: string) =>
  escapeMarkdown(text).split("\n").join("\\\n   ");

export const markdownText = (heading: string, rows: Row[]): string => {
  const blocks: string[] = [heading];
  const items: string[] = [];
  let item: string[] | undefined;

  const flush = () => {
    if (item) {
      items.push(item.join("\\\n   "));
    }

    item = undefined;
  };

  for (const row of rows) {
    switch (row.kind) {
      case "changed": {
        blocks.push(
          `Changed: ${row.headers.map(escapeMarkdown).join(", ") || "No answer changes"}`
        );
        break;
      }

      case "question": {
        flush();
        item = [`${row.index + 1}. **${escapeMarkdown(row.header)}**`];
        break;
      }

      case "answer": {
        item?.push(`✓ ${literal(row.text)}`);

        if (row.note !== undefined && row.note !== "") {
          item?.push(`Note: ${literal(row.note)}`);
        }

        break;
      }

      case "missing": {
        item?.push("○ Answer required");
        break;
      }

      case "note": {
        flush();

        if (items.length) {
          blocks.push(items.splice(0).join("\n"));
        }

        blocks.push(
          `**Questionnaire note**\\\n${escapeMarkdown(row.text).split("\n").join("\\\n")}`
        );
        break;
      }
    }
  }

  flush();

  if (items.length) {
    blocks.push(items.join("\n"));
  }

  return blocks.join("\n\n");
};
