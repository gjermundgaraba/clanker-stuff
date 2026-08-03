import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CommandRuntime } from "../command-runtime.js";
import { REVIEW_CLOSED_SENTINEL } from "../plannotator.js";

export const registerReviewCommand = (
  pi: ExtensionAPI,
  runtime: CommandRuntime
): void => {
  pi.registerCommand("plannotator-review", {
    description: "Review current changes, a base ref, or a pull request URL",
    handler: async (args, ctx) => {
      const tokens = runtime.parseArguments(args, ctx);
      if (tokens === undefined) {
        return;
      }

      runtime.launch(["review", ...tokens], ctx, {
        failureLabel: "Plannotator code review",
        onOutput(stdout) {
          const output = stdout.trim();
          if (output.length === 0 || output === REVIEW_CLOSED_SENTINEL) {
            ctx.ui.notify(
              "Plannotator code review closed without feedback.",
              "info"
            );
            return;
          }
          pi.sendUserMessage(output, { deliverAs: "followUp" });
        },
        openedMessage: "Plannotator code review opened.",
      });
    },
  });
};
