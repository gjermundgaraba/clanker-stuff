import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { readAnnotationFeedback } from "../annotations.js";
import type { CommandRuntime } from "../command-runtime.js";
import { parseArguments } from "../command-runtime.js";

const LABEL = "Plannotator message annotation";

const getLastAssistantText = (
  ctx: ExtensionCommandContext
): string | undefined => {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    const text = entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return undefined;
};

const anchorFeedback = (feedback: string, message: string): string => {
  const excerpt =
    message.length <= 1000 ? message : `${message.slice(0, 1000).trimEnd()}...`;

  const quote = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `This feedback applies to the assistant response excerpted below:\n\n${quote}\n\nUser feedback:\n${feedback}`;
};

export const createLastHandler =
  (pi: ExtensionAPI, runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const tokens = parseArguments(args, ctx);

    if (tokens === undefined) {
      return;
    }

    const message = getLastAssistantText(ctx);

    if (message === undefined) {
      ctx.ui.notify("No assistant message found in session.", "error");

      return;
    }

    runtime.launch(["annotate-last", "--stdin", "--json", ...tokens], ctx, {
      failureLabel: LABEL,
      onOutput(stdout) {
        const feedback = readAnnotationFeedback(stdout, ctx, LABEL);

        if (feedback === undefined) {
          return;
        }

        pi.sendUserMessage(
          `# Message Annotations\n\n${anchorFeedback(feedback, message)}\n\nPlease address the annotation feedback above.`,
          { deliverAs: "followUp" }
        );
      },
      openedMessage: "Plannotator message annotation opened.",
      stdin: message,
    });
  };
