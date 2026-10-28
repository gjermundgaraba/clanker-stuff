import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { submittedFields } from "./interaction.js";
import type { Interaction, Submission } from "./interaction.js";
import { submissionChanges } from "./summary.js";

export const AnswerEnvelopeSchema = Type.Object(
  {
    type: Type.Literal("questionnaire_answer"),
    interaction_id: Type.String(),
    title: Type.Optional(Type.String()),
    ...submittedFields,
    changed: Type.Array(Type.String()),
  },
  { additionalProperties: false }
);

export type AnswerEnvelope = Static<typeof AnswerEnvelopeSchema>;

export const answerEnvelope = (
  item: Interaction,
  submission: Submission
): AnswerEnvelope => ({
  type: "questionnaire_answer",
  interaction_id: item.id,
  ...(item.request.title === undefined ? {} : { title: item.request.title }),
  revision: submission.revision,
  timestamp: submission.timestamp,
  initiated_by: submission.initiated_by,
  ...(submission.reason === undefined ? {} : { reason: submission.reason }),
  ...(submission.tool_call_id === undefined
    ? {}
    : { tool_call_id: submission.tool_call_id }),
  mode: submission.mode,
  answers: submission.answers,
  note: submission.note,
  changed: submissionChanges(item, submission) ?? [],
});

export const answerSummary = (envelope: AnswerEnvelope): string => {
  const summary = [
    `${envelope.title ?? "Questionnaire"} · ${envelope.interaction_id} · revision ${envelope.revision}${envelope.revision > 1 ? ` · supersedes revision ${envelope.revision - 1}` : ""}`,
    ...Object.values(envelope.answers).map(
      (a) =>
        `${a.header}: ${[...a.selections.map((s) => s.label), ...(a.custom ? [a.custom.text] : [])].join(", ")}`
    ),
  ].join("\n");

  return summary.length > 700
    ? `${summary.slice(0, 680)}… (full structured answer below)`
    : summary;
};

export const answerMessage = (envelope: AnswerEnvelope): string =>
  `${answerSummary(envelope)}\n\n${JSON.stringify(envelope)}`;

export const parseAnswerMessage = (
  text: string
): AnswerEnvelope | undefined => {
  const line = text.slice(text.lastIndexOf("\n") + 1);

  if (!line.startsWith('{"type":"questionnaire_answer"')) {
    return;
  }

  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return;
  }

  return Value.Check(AnswerEnvelopeSchema, value) &&
    answerMessage(value) === text
    ? value
    : undefined;
};

export const jsonResult = <T>(details: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
});
