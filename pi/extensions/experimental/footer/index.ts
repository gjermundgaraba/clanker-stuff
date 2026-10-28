import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFooterConfigStore } from "./config.js";
import { readGitDetails } from "./git.js";
import { createFooterHost } from "./host.js";

export default function footerExtension(
  pi: ExtensionAPI,
  configStore = createFooterConfigStore(),
  readGit = readGitDetails
): void {
  const host = createFooterHost(pi, configStore, readGit);

  pi.registerCommand("footer", {
    description: "Edit the footer layout as JSON, or reset or inspect it",
    getArgumentCompletions: host.completions,
    handler: host.command,
  });

  pi.on("session_start", async (_event, ctx) => {
    await host.start(ctx);
  });
  pi.on("model_select", host.requestRender);
  pi.on("turn_end", host.refreshGit);
  pi.on("session_shutdown", host.shutdown);
}
