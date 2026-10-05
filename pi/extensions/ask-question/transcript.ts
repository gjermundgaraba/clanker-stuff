import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AnswerEnvelopeSchema, parseAnswerMessage } from "./delivery.js";
import type { AnswerEnvelope } from "./delivery.js";
import type { MarkdownTransformer, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { QuestionnaireSchema, RevisionSchema } from "./request.js";
import { escapeMarkdown, markdownText, plainText, submissionRows } from "./summary.js";

const supersedes = (revision: number) =>
  revision > 1 ? ` · supersedes revision ${revision - 1}` : "";

const envelopeRows = (envelope: AnswerEnvelope) =>
  submissionRows(
    envelope.answers,
    envelope.note,
    envelope.revision > 1 ? envelope.changed : undefined,
  );

/**
 * Display only: an exact answer message renders as a readable summary, while its canonical
 * text stays in model context and history. Edited, quoted or combined text stays verbatim, so
 * arbitrary user text is never hidden just because it resembles an answer.
 */
export const transformAnswerMarkdown: MarkdownTransformer = (markdown, context) => {
  const envelope = context.messageType === "user" ? parseAnswerMessage(markdown) : undefined;

  if (!envelope) return markdown;

  const heading =
    `**${escapeMarkdown(envelope.title ?? "Questionnaire")}** · answered · revision ${envelope.revision}` +
    `${supersedes(envelope.revision)}\\\n/answers to inspect or revise`;

  return markdownText(heading, envelopeRows(envelope));
};

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
  ["closed", "Closed without answering · draft kept · run stopped · /answers to resume"],
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
      summary = `Answered · revision ${details.revision}${supersedes(details.revision)}\n${plainText(envelopeRows(details))}`;
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
