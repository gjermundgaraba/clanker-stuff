import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CliStarter } from "./cli.js";
import { FEEDBACK_COMMAND } from "./feedback.js";
import { createPlannotatorHost } from "./host.js";

export default function plannotatorExtension(
  pi: ExtensionAPI,
  starter?: CliStarter
): void {
  const host = createPlannotatorHost(pi, starter);

  pi.registerCommand("plannotator-review", {
    description: "Review current changes or a pull request URL",
    handler: host.review,
  });

  pi.registerCommand("plannotator-annotate", {
    description: "Open a file, folder, or URL in the Plannotator annotation UI",
    handler: host.annotate,
  });

  pi.registerCommand("plannotator-last", {
    description: "Annotate the last assistant message",
    handler: host.last,
  });

  pi.registerCommand(FEEDBACK_COMMAND, {
    description: "Recover retained Plannotator feedback into the editor",
    handler: host.feedback,
  });

  pi.on("session_before_tree", host.invalidateTreeVersion);
  pi.on("session_tree", host.invalidateTreeVersion);

  pi.on("session_shutdown", async () => {
    await host.shutdown();
  });
}
