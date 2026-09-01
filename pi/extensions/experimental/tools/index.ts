import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createToolsRuntime } from "./runtime.js";

export default function toolsExtension(pi: ExtensionAPI): void {
  const runtime = createToolsRuntime(pi);

  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: (_args, ctx) => runtime.openPicker(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.start(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    runtime.apply(ctx, true, event.previousModel);
  });
  pi.on("session_tree", (_event, ctx) => {
    runtime.restore(ctx);
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "reload") {
      runtime.prepareReload(ctx);
    }
  });
}
