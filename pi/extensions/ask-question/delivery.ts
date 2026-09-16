import { Type } from "typebox";
import { SubmissionSchema } from "./interaction.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Interaction, Submission } from "./interaction.js";
import { submissionChanges } from "./interaction.js";

export const AnswerEnvelopeSchema = Type.Object(
  {
    type: Type.Literal("questionnaire_answer"),
    interaction_id: Type.String(),
    ...SubmissionSchema.properties,
    changed: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export function answerEnvelope(item: Interaction, submission: Submission) {
  return {
    type: "questionnaire_answer",
    interaction_id: item.id,
    ...submission,
    changed: submissionChanges(item, submission),
  };
}
export function answerSummary(item: Interaction, submission: Submission): string {
  const summary = [
    `${item.request.title ?? "Questionnaire"} · ${item.id} · revision ${submission.revision}${submission.parent_revision ? ` · supersedes revision ${submission.parent_revision}` : ""}`,
    ...Object.values(submission.answers).map(
      (a) =>
        `${a.header}: ${[...a.selections.map((s) => s.label), ...(a.custom ? [a.custom.text] : [])].join(", ")}`,
    ),
  ].join("\n");
  return summary.length > 700
    ? `${summary.slice(0, 680)}… (full structured answer below)`
    : summary;
}
export function answerMessage(item: Interaction, submission: Submission): string {
  return `${answerSummary(item, submission)}\n\n${JSON.stringify(answerEnvelope(item, submission))}`;
}
export function answerResult(item: Interaction, submission: Submission) {
  const details = answerEnvelope(item, submission);
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
/** Correlation requires exact authored answer content, never a receipt or an ID substring. */
export function isDelivered(
  item: Interaction,
  submission: Submission,
  branch: SessionEntry[],
): boolean {
  const resultText = JSON.stringify(answerEnvelope(item, submission));
  return branch.some((entry) => {
    if (entry.type !== "message") return false;
    const message = entry.message;
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      // TUI Stop can restore this answer alongside unrelated queued text.
      // Require the complete immutable envelope, not a coincidental ID substring.
      return text.split("\n").some((line) => line.trim() === resultText);
    }
    return (
      message.role === "toolResult" &&
      !message.isError &&
      submission.mode === "blocking" &&
      message.toolName === "request_user_input" &&
      message.toolCallId === submission.tool_call_id &&
      message.content.some((c) => c.type === "text" && c.text === resultText)
    );
  });
}
