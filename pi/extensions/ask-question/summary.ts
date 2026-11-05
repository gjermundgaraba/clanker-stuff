import { displayText } from "@clanker-stuff/pi-tool-rendering/text";

import { draftAnswer } from "./interaction.js";
import type { Answer, Answers, Interaction } from "./interaction.js";

export const oneLine = (text: string) =>
  displayText(text).replaceAll(/\s+/gu, " ");

type Row =
  | { kind: "question"; index: number; header: string }
  | { kind: "answer"; text: string; note?: string }
  | { kind: "missing" };

const answerRows = (answer: Answer): Row[] => {
  const rows: Row[] = [];

  for (const s of answer.selections) {
    rows.push({
      kind: "answer",
      text: s.label,
      ...(s.note === undefined ? {} : { note: s.note }),
    });
  }

  if (answer.custom) {
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

export const answersRows = (answers: Answers): Row[] =>
  Object.values(answers).flatMap((answer, index) => [
    { kind: "question" as const, index, header: answer.header },
    ...answerRows(answer),
  ]);

/** Rows for a draft's current answers, in question order. */
export const draftRows = (item: Interaction): Row[] =>
  answersRows(
    Object.fromEntries(
      item.request.questions.map((q) => [q.id, draftAnswer(item, q)])
    )
  );

const indent = (text: string, first: string, rest: string): string =>
  displayText(text)
    .split("\n")
    .map((line, i) => (i ? rest : first) + line)
    .join("\n");

export const plainText = (rows: Row[]): string => {
  const lines: string[] = [];

  for (const row of rows) {
    switch (row.kind) {
      case "question": {
        if (lines.length) {
          lines.push("");
        }

        lines.push(`${row.index + 1}. ${displayText(row.header)}`);
        break;
      }

      case "answer": {
        lines.push(indent(`✓ ${row.text}`, "  ", "    "));

        if (row.note !== undefined && row.note !== "") {
          lines.push(indent(`Note: ${row.note}`, "    ", "          "));
        }

        break;
      }

      case "missing": {
        lines.push("  ○ Answer required");
        break;
      }
    }
  }

  return lines.join("\n");
};
