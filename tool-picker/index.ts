import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createToolSelection } from "./selection.js";

export default function toolsExtension(pi: ExtensionAPI): void {
  const selection = createToolSelection(pi);

  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: (_args, ctx) => selection.open(ctx),
  });

  pi.on("session_start", (_event, ctx) => selection.start(ctx));
  pi.on("session_tree", (_event, ctx) => selection.restore(ctx));
}
