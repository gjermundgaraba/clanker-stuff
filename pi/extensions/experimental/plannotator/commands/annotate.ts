import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { parseAnnotationOutcome } from "../annotations.js";
import type { CommandRuntime } from "../command-runtime.js";

export const createAnnotateHandler =
  (pi: ExtensionAPI, runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const tokens = runtime.parseArguments(args, ctx);

    if (tokens === undefined) {
      return;
    }

    // Plannotator validates its own options; the header shows the arguments as typed.
    const target = args.trim();

    if (!tokens.some((token) => token !== "" && !token.startsWith("-"))) {
      ctx.ui.notify(
        "Usage: /plannotator-annotate <file | folder | URL> [--markdown] [--no-jina] [--gate]",
        "error",
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
          ctx.ui.notify("Plannotator annotation closed without feedback.", "info");

          return;
        }

        pi.sendUserMessage(
          `# Markdown Annotations\n\nFile: ${target}\n\n${feedback}\n\nPlease address the annotation feedback above.`,
          { deliverAs: "followUp" },
        );
      },
      openedMessage: "Plannotator annotation opened.",
    });
  };
