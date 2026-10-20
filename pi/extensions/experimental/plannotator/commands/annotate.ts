import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { readAnnotationFeedback } from "../annotations.js";
import type { CommandRuntime } from "../command-runtime.js";
import { parseArguments } from "../command-runtime.js";

/** Names this command in its failure and outcome notices. */
const LABEL = "Plannotator annotation";

export const createAnnotateHandler =
  (pi: ExtensionAPI, runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const tokens = parseArguments(args, ctx);

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
      failureLabel: LABEL,
      onOutput(stdout) {
        const feedback = readAnnotationFeedback(stdout, ctx, LABEL);

        if (feedback === undefined) {
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
