import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPlannotatorHost } from "./host.js";

export default function plannotatorExtension(pi: ExtensionAPI): void {
  const host = createPlannotatorHost(pi);

  pi.registerCommand("plannotator-review", {
    description: "Review current changes, a base ref, or a pull request URL",
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

  pi.on("session_shutdown", () => host.shutdown());
}
