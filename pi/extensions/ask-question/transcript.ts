import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  MarkdownTransformer,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { AnswerEnvelopeSchema, parseAnswerMessage } from "./delivery.js";
import type { AnswerEnvelope } from "./delivery.js";
import type { Mode } from "./interaction.js";
import type { QuestionnaireSchema, RevisionSchema } from "./request.js";
import {
  escapeMarkdown,
  markdownText,
  plainText,
  submissionRows,
} from "./summary.js";

const supersedes = (revision: number) =>
  revision > 1 ? ` · supersedes revision ${revision - 1}` : "";

const envelopeRows = (envelope: AnswerEnvelope) =>
  submissionRows(
    envelope.answers,
    envelope.note,
    envelope.revision > 1 ? envelope.changed : undefined
  );

export const transformAnswerMarkdown: MarkdownTransformer = (
  markdown,
  context
) => {
  const envelope =
    context.messageType === "user" ? parseAnswerMessage(markdown) : undefined;

  if (!envelope) {
    return markdown;
  }

  const heading =
    `**${escapeMarkdown(envelope.title ?? "Questionnaire")}** · answered · revision ${envelope.revision}` +
    `${supersedes(envelope.revision)}\\\n/answers to inspect or revise`;

  return markdownText(heading, envelopeRows(envelope));
};

type CallRenderer = NonNullable<
  ToolDefinition<typeof QuestionnaireSchema>["renderCall"]
>;

type ReviseCallRenderer = NonNullable<
  ToolDefinition<typeof RevisionSchema>["renderCall"]
>;

const callHeading = (
  heading: string,
  argsJson: string,
  theme: Parameters<CallRenderer>[1],
  context: { readonly expanded: boolean }
) => {
  const expanded = context.expanded ? `\n${argsJson}` : "";
  const line = displayText(heading).replaceAll(/\s+/gu, " ");

  return preview(
    () =>
      new Text(theme.fg("toolTitle", `${line}${displayText(expanded)}`), 0, 0),
    context.expanded
  );
};

export const renderCall = (
  args: Parameters<CallRenderer>[0],
  theme: Parameters<CallRenderer>[1],
  context: Parameters<CallRenderer>[2],
  mode: Mode
) => {
  const count = Array.isArray(args.questions) ? args.questions.length : 0;
  const title = args.title ?? "Questionnaire";

  return callHeading(
    `${title} · ${mode} · ${count} question${count === 1 ? "" : "s"}`,
    JSON.stringify(args, null, 2),
    theme,
    context
  );
};

export const renderReviseCall = (
  args: Parameters<ReviseCallRenderer>[0],
  theme: Parameters<ReviseCallRenderer>[1],
  context: { readonly expanded: boolean },
  titleOf: (interactionId: string) => string | undefined
) => {
  const title = titleOf(args.interaction_id) ?? "Questionnaire";

  return callHeading(
    `${title} · revision request`,
    JSON.stringify(args, null, 2),
    theme,
    context
  );
};

const ReceiptDisplaySchema = Type.Object({
  accepted: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.String()),
});

const STATUS_LABELS = new Map([
  ["cancelled", "Cancelled by the user · nothing answered · run stopped"],
  [
    "closed",
    "Closed without answering · draft kept · run stopped · /answers to resume",
  ],
  ["pending", "Pending · not answered yet · /answers to answer"],
]);

const resultSummary = (text: string): string => {
  let details: unknown;

  try {
    details = JSON.parse(text);
  } catch {
    return text;
  }

  if (Value.Check(AnswerEnvelopeSchema, details)) {
    return `Answered · revision ${details.revision}${supersedes(details.revision)}\n${plainText(envelopeRows(details))}`;
  }

  if (Value.Check(ReceiptDisplaySchema, details)) {
    const status =
      details.accepted === true ? "pending" : (details.status ?? "");

    return STATUS_LABELS.get(status) ?? (status || text);
  }

  return text;
};

export const renderResult: NonNullable<
  ToolDefinition<
    typeof QuestionnaireSchema | typeof RevisionSchema
  >["renderResult"]
> = (result, options, theme, context) => {
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const summary =
    context.isError || options.isPartial ? text : resultSummary(text);

  let color: ThemeColor = "toolOutput";

  if (context.isError) {
    color = "error";
  } else if (options.isPartial) {
    color = "warning";
  }

  return preview(
    () =>
      new Text(
        theme.fg(color, displayText(options.expanded ? text : summary)),
        0,
        0
      ),
    options.expanded
  );
};
