import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { Value } from "typebox/value";
import { AnswerEnvelopeSchema, answerMessage } from "./delivery.js";
import type { MarkdownTransformer, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Interaction, Submission } from "./interaction.js";
import { Text } from "@earendil-works/pi-tui";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { RequestSchema } from "./request.js";
import {
  escapeMarkdown,
  interactionRows,
  markdownText,
  plainText,
  submissionRows,
} from "./summary.js";

function submittedAnswerMarkdown(item: Interaction, submission: Submission): string {
  const heading =
    `**${escapeMarkdown(item.request.title ?? "Questionnaire")}** · answered · revision ${submission.revision}` +
    `${submission.parent_revision ? ` · supersedes revision ${submission.parent_revision}` : ""}\\\n` +
    "/answers to inspect or revise";
  return markdownText(heading, interactionRows(item, submission));
}

/** Display only: canonical messages, model context and delivery matching stay untouched. */
export function createAnswerMarkdownTransformer(
  readInteractions: () => Iterable<Interaction>,
): MarkdownTransformer {
  return (markdown, context) => {
    if (context.messageType !== "user" || !markdown.includes('"type":"questionnaire_answer"'))
      return markdown;
    for (const item of readInteractions())
      for (const submission of item.submissions)
        if (markdown === answerMessage(item, submission))
          return submittedAnswerMarkdown(item, submission);
    // Edited, quoted, combined queue text and unknown-branch messages remain
    // verbatim: never hide arbitrary user text just because it resembles an answer.
    return markdown;
  };
}

type CallRenderer = NonNullable<ToolDefinition<typeof RequestSchema>["renderCall"]>;
export function renderCall(
  args: Parameters<CallRenderer>[0],
  theme: Parameters<CallRenderer>[1],
  context: Parameters<CallRenderer>[2],
  mode: "blocking" | "async",
  titleOf: (interactionId: string) => string | undefined = () => undefined,
) {
  const revise = "revise" in args && args.revise ? args.revise : undefined;
  const questions = "questions" in args && Array.isArray(args.questions) ? args.questions : [];
  const title =
    (revise ? titleOf(revise.interaction_id) : "title" in args ? args.title : undefined) ??
    "Questionnaire";
  const suffix = revise
    ? " · revision request"
    : ` · ${questions.length} question${questions.length === 1 ? "" : "s"}`;
  const expanded = context.expanded ? `\n${JSON.stringify(args, null, 2)}` : "";
  const heading = displayText(`${title} · ${mode}${suffix}`).replaceAll(/\s+/g, " ");
  return preview(
    () => new Text(theme.fg("toolTitle", `${heading}${displayText(expanded)}`), 0, 0),
    context.expanded,
  );
}

const STATUS_LABELS = new Map([
  ["cancelled", "Cancelled by the user · nothing answered · run stopped"],
  ["delivery_paused", "Closed without answering · draft kept · run stopped · /answers to resume"],
  ["pending", "Pending · not answered yet · /answers to answer"],
]);
export const renderResult: NonNullable<ToolDefinition<typeof RequestSchema>["renderResult"]> = (
  result,
  options,
  theme,
  context,
) => {
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  let summary = text;
  try {
    const details = JSON.parse(text);
    if (!context.isError && !options.isPartial && Value.Check(AnswerEnvelopeSchema, details)) {
      summary = `Answered · revision ${details.revision}${details.parent_revision ? ` · supersedes revision ${details.parent_revision}` : ""}\n${plainText(
        submissionRows(
          details.answers,
          details.note,
          details.parent_revision ? details.changed : undefined,
        ),
      )}`;
    } else if (!context.isError && !options.isPartial && details && typeof details === "object") {
      const status = details.accepted ? "pending" : String(details.status ?? "");
      summary = STATUS_LABELS.get(status) ?? (status || text);
    }
  } catch {
    /* Tool execution errors are plain text. */
  }
  return preview(
    () =>
      new Text(
        theme.fg(
          context.isError ? "error" : options.isPartial ? "warning" : "toolOutput",
          displayText(options.expanded ? text : summary),
        ),
        0,
        0,
      ),
    options.expanded,
  );
};
