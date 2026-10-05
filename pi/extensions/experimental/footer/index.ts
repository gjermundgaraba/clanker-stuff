import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFooterConfigStore } from "./config.js";
import { readGitDetails } from "./git.js";
import { createFooterHost } from "./host.js";

export default function footerExtension(
  pi: ExtensionAPI,
  configStore = createFooterConfigStore(),
  readGit = readGitDetails,
): void {
  const host = createFooterHost(pi, configStore, readGit);

  pi.registerCommand("footer", {
    description: "Edit the footer layout as JSON, or reset or inspect it",
    handler: (args, ctx) => host.command(args, ctx),
  });

  pi.on("session_start", (_event, ctx) => host.start(ctx));
  // Built-in widgets are computed while rendering; these only cover what Pi does not re-render.
  pi.on("model_select", () => {
    host.requestRender();
  });
  pi.on("turn_end", () => {
    host.refreshGit();
  });
  pi.on("session_shutdown", () => {
    host.shutdown();
  });
}
