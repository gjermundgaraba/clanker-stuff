import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AnswerEnvelopeSchema, answerMessage } from "./delivery.js";
import type { MarkdownTransformer, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Interaction, Submission } from "./interaction.js";
import { Text } from "@earendil-works/pi-tui";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { QuestionnaireSchema, RevisionSchema } from "./request.js";
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

type CallRenderer = NonNullable<ToolDefinition<typeof QuestionnaireSchema>["renderCall"]>;

type ReviseCallRenderer = NonNullable<ToolDefinition<typeof RevisionSchema>["renderCall"]>;

const callHeading = (
  heading: string,
  argsJson: string,
  theme: Parameters<CallRenderer>[1],
  context: { readonly expanded: boolean },
) => {
  const expanded = context.expanded ? `\n${argsJson}` : "";
  const line = displayText(heading).replaceAll(/\s+/g, " ");

  return preview(
    () => new Text(theme.fg("toolTitle", `${line}${displayText(expanded)}`), 0, 0),
    context.expanded,
  );
};

// Stored calls are rendered as written, so both renderers tolerate partial arguments.
export function renderCall(
  args: Parameters<CallRenderer>[0],
  theme: Parameters<CallRenderer>[1],
  context: Parameters<CallRenderer>[2],
  mode: "blocking" | "async",
) {
  const count = Array.isArray(args.questions) ? args.questions.length : 0;
  const title = args.title ?? "Questionnaire";

  return callHeading(
    `${title} · ${mode} · ${count} question${count === 1 ? "" : "s"}`,
    JSON.stringify(args, null, 2),
    theme,
    context,
  );
}

export function renderReviseCall(
  args: Parameters<ReviseCallRenderer>[0],
  theme: Parameters<ReviseCallRenderer>[1],
  context: { readonly expanded: boolean },
  titleOf: (interactionId: string) => string | undefined,
) {
  const title = titleOf(args.interaction_id) ?? "Questionnaire";

  return callHeading(`${title} · revision request`, JSON.stringify(args, null, 2), theme, context);
}

const ReceiptDisplaySchema = Type.Object({
  accepted: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.String()),
});

const STATUS_LABELS = new Map([
  ["cancelled", "Cancelled by the user · nothing answered · run stopped"],
  ["delivery_paused", "Closed without answering · draft kept · run stopped · /answers to resume"],
  ["pending", "Pending · not answered yet · /answers to answer"],
]);

export const renderResult: NonNullable<
  ToolDefinition<typeof QuestionnaireSchema | typeof RevisionSchema>["renderResult"]
> = (result, options, theme, context) => {
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  let summary = text;

  try {
    const details: unknown = JSON.parse(text);

    if (!context.isError && !options.isPartial && Value.Check(AnswerEnvelopeSchema, details)) {
      summary = `Answered · revision ${details.revision}${details.parent_revision ? ` · supersedes revision ${details.parent_revision}` : ""}\n${plainText(
        submissionRows(
          details.answers,
          details.note,
          details.parent_revision ? details.changed : undefined,
        ),
      )}`;
    } else if (
      !context.isError &&
      !options.isPartial &&
      Value.Check(ReceiptDisplaySchema, details)
    ) {
      const status = details.accepted ? "pending" : (details.status ?? "");
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
