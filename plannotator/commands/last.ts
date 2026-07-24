import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { CommandRuntime } from "../command-runtime.js";
import { notifyError } from "../command-runtime.js";
import {
  normalizeAnnotationArguments,
  parseAnnotationOutcome,
} from "../plannotator.js";

interface AssistantSnapshot {
  entryId: string;
  text: string;
}

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];

const getAssistantText = (message: SessionMessage): string | undefined => {
  if (message.role !== "assistant") {
    return undefined;
  }

  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
};

const getLastAssistantSnapshot = (
  ctx: ExtensionCommandContext
): AssistantSnapshot | undefined => {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message") {
      continue;
    }
    const text = getAssistantText(entry.message);
    if (text !== undefined) {
      return { entryId: entry.id, text };
    }
  }
  return undefined;
};

const hasMovedPastSnapshot = (
  ctx: ExtensionCommandContext,
  entryId: string
): boolean => {
  if (!ctx.isIdle()) {
    return true;
  }
  const branch = ctx.sessionManager.getBranch();
  const index = branch.findIndex((entry) => entry.id === entryId);
  if (index === -1) {
    return true;
  }
  return branch.slice(index + 1).some((entry) => entry.type === "message");
};

const anchorFeedback = (feedback: string, message: string): string => {
  const trimmed = message.trim();
  const excerpt =
    trimmed.length <= 1000 ? trimmed : `${trimmed.slice(0, 1000).trimEnd()}...`;
  const quote = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `This feedback applies to the earlier assistant response excerpted below:\n\n${quote}\n\nUser feedback:\n${feedback}`;
};

export const registerLastCommand = (
  pi: ExtensionAPI,
  runtime: CommandRuntime
): void => {
  pi.registerCommand("plannotator-last", {
    description: "Annotate the last assistant message",
    handler: async (args, ctx) => {
      const parsed = runtime.parseArguments(args, ctx);
      if (parsed === undefined) {
        return;
      }

      let tokens: string[];
      try {
        tokens = normalizeAnnotationArguments(
          parsed,
          new Set(["--json", "--stdin"])
        );
      } catch (error) {
        notifyError(ctx, "Invalid Plannotator arguments", error);
        return;
      }

      const snapshot = getLastAssistantSnapshot(ctx);
      if (snapshot === undefined) {
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

          let feedback = outcome.feedback.trim();
          if (feedback.length === 0) {
            ctx.ui.notify(
              "Plannotator message annotation closed without feedback.",
              "info"
            );
            return;
          }
          if (hasMovedPastSnapshot(ctx, snapshot.entryId)) {
            feedback = anchorFeedback(feedback, snapshot.text);
          }
          pi.sendUserMessage(
            `# Message Annotations\n\n${feedback}\n\nPlease address the annotation feedback above.`,
            { deliverAs: "followUp" }
          );
        },
        openedMessage: "Plannotator message annotation opened.",
        stdin: snapshot.text,
      });
    },
  });
};
