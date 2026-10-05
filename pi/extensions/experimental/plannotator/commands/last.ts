import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { parseAnnotationOutcome } from "../annotations.js";
import type { CommandRuntime } from "../command-runtime.js";

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];

const getAssistantText = (message: SessionMessage): string | undefined => {
  if (message.role !== "assistant") {
    return undefined;
  }

  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
};

const getLastAssistantText = (ctx: ExtensionCommandContext): string | undefined => {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    const text = entry.type === "message" ? getAssistantText(entry.message) : undefined;

    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
};

// The review can outlive later turns, so feedback always names the response it is about.
// `message` is the trimmed text getLastAssistantText returned.
const anchorFeedback = (feedback: string, message: string): string => {
  const excerpt = message.length <= 1000 ? message : `${message.slice(0, 1000).trimEnd()}...`;

  const quote = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `This feedback applies to the assistant response excerpted below:\n\n${quote}\n\nUser feedback:\n${feedback}`;
};

export const createLastHandler =
  (pi: ExtensionAPI, runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const tokens = runtime.parseArguments(args, ctx);

    if (tokens === undefined) {
      return;
    }

    const message = getLastAssistantText(ctx);

    if (message === undefined) {
      ctx.ui.notify("No assistant message found in session.", "error");

      return;
    }

    runtime.launch(["annotate-last", "--stdin", "--json", ...tokens], ctx, {
      failureLabel: "Plannotator message annotation",
      onOutput(stdout) {
        const outcome = parseAnnotationOutcome(stdout);

        if (outcome.decision === "approved") {
          ctx.ui.notify("Plannotator message approved.", "info");

          return;
        }

        if (outcome.decision === "dismissed") {
          ctx.ui.notify("Plannotator message annotation closed.", "info");

          return;
        }

        const feedback = outcome.feedback.trim();

        if (feedback.length === 0) {
          ctx.ui.notify("Plannotator message annotation closed without feedback.", "info");

          return;
        }

        pi.sendUserMessage(
          `# Message Annotations\n\n${anchorFeedback(feedback, message)}\n\nPlease address the annotation feedback above.`,
          { deliverAs: "followUp" },
        );
      },
      openedMessage: "Plannotator message annotation opened.",
      stdin: message,
    });
  };
