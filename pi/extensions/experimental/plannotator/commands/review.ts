import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CommandRuntime } from "../command-runtime.js";

export const REVIEW_CLOSED_SENTINEL = "Review session closed without feedback.";

export const createReviewHandler =
  (pi: ExtensionAPI, runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const tokens = runtime.parseArguments(args, ctx);
    if (tokens === undefined) {
      return;
    }

    runtime.launch(["review", ...tokens], ctx, {
      failureLabel: "Plannotator code review",
      onOutput(stdout) {
        const output = stdout.trim();
        if (output.length === 0 || output === REVIEW_CLOSED_SENTINEL) {
          ctx.ui.notify("Plannotator code review closed without feedback.", "info");
          return;
        }
        pi.sendUserMessage(output, { deliverAs: "followUp" });
      },
      openedMessage: "Plannotator code review opened.",
    });
  };
