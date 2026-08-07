import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  findAnnotationTarget,
  normalizeAnnotationArguments,
  parseAnnotationOutcome,
} from "../annotations.js";
import type { CommandRuntime } from "../command-runtime.js";
import { notifyError } from "../command-runtime.js";

export const createAnnotateHandler =
  (pi: ExtensionAPI, runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const parsed = runtime.parseArguments(args, ctx);
    if (parsed === undefined) {
      return;
    }

    let tokens: string[];
    try {
      tokens = normalizeAnnotationArguments(parsed, new Set(["--json"]));
    } catch (error) {
      notifyError(ctx, "Invalid Plannotator arguments", error);
      return;
    }

    const target = findAnnotationTarget(tokens);
    if (target === undefined) {
      ctx.ui.notify(
        "Usage: /plannotator-annotate <file | folder | URL> [--markdown] [--no-jina] [--gate]",
        "error"
      );
      return;
    }

    runtime.launch(["annotate", ...tokens, "--json"], ctx, {
      failureLabel: "Plannotator annotation",
      onOutput(stdout) {
        const outcome = parseAnnotationOutcome(stdout);
        if (outcome.decision === "approved") {
          ctx.ui.notify("Plannotator annotation approved.", "info");
          return;
        }
        if (outcome.decision === "dismissed") {
          ctx.ui.notify("Plannotator annotation closed.", "info");
          return;
        }

        const feedback = outcome.feedback.trim();
        if (feedback.length === 0) {
          ctx.ui.notify(
            "Plannotator annotation closed without feedback.",
            "info"
          );
          return;
        }
        pi.sendUserMessage(
          `# Markdown Annotations\n\nFile: ${target}\n\n${feedback}\n\nPlease address the annotation feedback above.`,
          { deliverAs: "followUp" }
        );
      },
      openedMessage: "Plannotator annotation opened.",
    });
  };
