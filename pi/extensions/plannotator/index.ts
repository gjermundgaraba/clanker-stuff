import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createCommandRuntime,
  startPlannotatorCli,
} from "./command-runtime.js";
import { createAnnotateHandler } from "./commands/annotate.js";
import { createLastHandler } from "./commands/last.js";
import { createReviewHandler } from "./commands/review.js";
import { createTargetedReviewStarter } from "./review-launcher.js";

export default function plannotatorExtension(pi: ExtensionAPI): void {
  const runtime = createCommandRuntime(
    createTargetedReviewStarter(startPlannotatorCli)
  );

  pi.registerCommand("plannotator-review", {
    description: "Review current changes, a base ref, or a pull request URL",
    handler: createReviewHandler(pi, runtime),
  });

  pi.registerCommand("plannotator-annotate", {
    description: "Open a file, folder, or URL in the Plannotator annotation UI",
    handler: createAnnotateHandler(pi, runtime),
  });

  pi.registerCommand("plannotator-last", {
    description: "Annotate the last assistant message",
    handler: createLastHandler(pi, runtime),
  });

  pi.on("session_shutdown", runtime.shutdown);
}
