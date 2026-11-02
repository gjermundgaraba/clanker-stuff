import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  MessageRenderer,
  Theme,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { readOutcome } from "./delivery.js";
import type { Outcome } from "./delivery.js";
import type { QuestionnaireSchema } from "./request.js";
import { answersRows, plainText } from "./summary.js";

type Definition = ToolDefinition<typeof QuestionnaireSchema>;

const oneLine = (text: string) => displayText(text).replaceAll(/\s+/gu, " ");

export const renderCall: NonNullable<Definition["renderCall"]> = (
  args,
  theme,
  context
) => {
  const count = Array.isArray(args.questions) ? args.questions.length : 0;

  const heading = oneLine(
    `${args.title ?? "Questionnaire"} · ${args.wait ? "waiting" : "async"} · ${count} question${count === 1 ? "" : "s"}`
  );

  const expanded = context.expanded
    ? `\n${displayText(JSON.stringify(args, null, 2))}`
    : "";

  return preview(
    () => new Text(theme.fg("toolTitle", `${heading}${expanded}`), 0, 0),
    context
  );
};

const STATUS: Record<Outcome["status"], { text: string; color: ThemeColor }> = {
  answered: { text: "✓ Answered", color: "success" },
  pending: {
    text: "Pending · not answered yet · /answers to answer",
    color: "muted",
  },
  closed: {
    text: "Closed without answering · draft kept · run stopped · /answers to resume",
    color: "warning",
  },
  dismissed: { text: "Dismissed · not answered", color: "warning" },
};

const outcomeText = (details: Outcome, theme: Theme, titled: boolean) => {
  const status = STATUS[details.status];
  const title = titled ? `${oneLine(details.title ?? "Questionnaire")} · ` : "";
  const heading = theme.fg(status.color, `${title}${status.text}`);

  return details.answers
    ? `${heading}\n${theme.fg("toolOutput", plainText(answersRows(details.answers)))}`
    : heading;
};

export const renderResult: NonNullable<Definition["renderResult"]> = (
  result,
  options,
  theme,
  context
) => {
  const details = readOutcome(result.details);

  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => displayText(c.text))
    .join("\n");

  let body = theme.fg("toolOutput", text);

  if (context.isError) {
    body = theme.fg("error", text);
  } else if (options.isPartial) {
    body = theme.fg("warning", text);
  } else if (details) {
    body = outcomeText(details, theme, false);
  }

  return preview(() => new Text(body, 0, 0), context);
};

/** Renders answers and dismissals that arrived as messages, from their own details. */
export const renderOutcomeMessage: MessageRenderer = (
  message,
  options,
  theme
) => {
  const details = readOutcome(message.details);

  if (!details) {
    return;
  }

  return preview(
    () => new Text(outcomeText(details, theme, true), options.outputPad, 0),
    options,
    12
  );
};
