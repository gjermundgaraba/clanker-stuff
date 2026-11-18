import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CommandRuntime } from "../command-runtime.js";
import { parseArguments } from "../command-runtime.js";

const LABEL = "Plannotator code review";

const REVIEW_CLOSED_SENTINEL = "Review session closed without feedback.";

export const createReviewHandler =
  (runtime: CommandRuntime) =>
  async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const tokens = parseArguments(args, ctx);

    if (tokens === undefined) {
      return;
    }

    runtime.launch(["review", ...tokens], ctx, {
      label: LABEL,
      readFeedback(stdout) {
        const output = stdout.trim();

        if (output.length === 0 || output === REVIEW_CLOSED_SENTINEL) {
          ctx.ui.notify(`${LABEL} closed without feedback.`, "info");

          return undefined;
        }

        return output;
      },
    });
  };
