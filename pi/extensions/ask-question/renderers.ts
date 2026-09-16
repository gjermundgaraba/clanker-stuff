/** Transcript snapshots only; later asynchronous answers have their own session messages. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;
type QuestionTool = "ask_question" | "request_user_input_async" | "send_message_to_user_async";
type Data = Record<string, unknown>;
// SAFETY: Values remain unknown; only non-null, non-array objects pass.
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const text = (value: unknown): string => (typeof value === "string" ? displayText(value) : "");
const inline = (value: unknown): string => (typeof value === "string" ? inlineText(value) : "");
const questions = (args: unknown): Data[] => {
  const value = record(args).questions;
  return Array.isArray(value) ? value.map(record) : [];
};
const heading = (question: Data, index: number): string =>
  inline(question.header) || `Q${index + 1}`;

export const questionRenderers = (name: QuestionTool): Renderers => ({
  renderCall(args, theme, context) {
    return preview(() => {
      const lines = [theme.fg("toolTitle", theme.bold(name))];
      if (name === "send_message_to_user_async") {
        const message = text(record(args).message);
        if (message) lines.push(theme.fg("toolOutput", message));
      } else {
        for (const [index, question] of questions(args).entries()) {
          lines.push(
            `${theme.fg("accent", heading(question, index))} · ${theme.fg("toolOutput", text(question.question ?? question.title))}`,
          );
          if (question.multiSelect === true) lines.push(theme.fg("muted", "Choose one or more"));
          if (Array.isArray(question.options)) {
            for (const option of question.options) {
              const data = record(option);
              lines.push(
                theme.fg(
                  "toolOutput",
                  `- ${text(typeof option === "string" ? option : data.label)}`,
                ),
              );
              if (text(data.details)) lines.push(theme.fg("muted", text(data.details)));
            }
          }
          if (text(question.placeholder)) lines.push(theme.fg("muted", text(question.placeholder)));
        }
      }
      if (context.isPartial)
        lines.push(
          theme.fg(
            "warning",
            !context.executionStarted
              ? "…"
              : name === "ask_question"
                ? "Waiting for answers"
                : "Submitting",
          ),
        );
      return new Text(lines.join("\n"), 0, 0);
    }, context.expanded);
  },
  renderResult(result, options, theme, context) {
    return preview(() => {
      const content = result.content
        .filter((item) => item.type === "text")
        .map((item) => displayText(item.text))
        .join("\n");
      if (context.isError || options.isPartial)
        return new Text(
          theme.fg(
            context.isError ? "error" : "warning",
            content || (context.isError ? "Request failed" : "Waiting for response"),
          ),
          0,
          0,
        );
      const details = record(result.details);
      if (name !== "ask_question" && details.accepted === true)
        return new Text(
          theme.fg(
            "success",
            name === "request_user_input_async" ? "✓ Question queued" : "✓ Message submitted",
          ),
          0,
          0,
        );
      if (name === "ask_question" && details.cancelled === true) {
        const reason =
          details.reason === "user_cancelled"
            ? "Cancelled by user"
            : details.reason === "external_aborted"
              ? "Cancelled: run aborted"
              : "Cancelled";
        return new Text(
          theme.fg(
            "warning",
            reason +
              (details.abortedRun === true && details.reason !== "external_aborted"
                ? " · run aborted"
                : ""),
          ),
          0,
          0,
        );
      }
      if (
        name === "ask_question" &&
        details.cancelled === false &&
        Array.isArray(details.answers) &&
        details.answers.length > 0 &&
        details.answers.every(
          (answer) =>
            Array.isArray(answer) &&
            answer.length > 0 &&
            answer.every((selection) => typeof record(selection).label === "string"),
        )
      ) {
        const prompts = questions(context.args);
        const lines = [theme.fg("success", "✓ Answers received")];
        for (const [index, answer] of details.answers.entries()) {
          const question = prompts[index] ?? {};
          lines.push(theme.fg("accent", heading(question, index)));
          if (options.expanded && text(question.question))
            lines.push(theme.fg("muted", text(question.question)));
          for (const selection of answer) {
            const item = record(selection);
            lines.push(theme.fg("toolOutput", `- ${text(item.label)}`));
            if (text(item.note)) lines.push(theme.fg("muted", `Note: ${text(item.note)}`));
          }
        }
        return new Text(lines.join("\n"), 0, 0);
      }
      return new Text(theme.fg("toolOutput", content || "(no output)"), 0, 0);
    }, options.expanded);
  },
});
