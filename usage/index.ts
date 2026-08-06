import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createUsageController } from "./controller.js";

export default function usageExtension(pi: ExtensionAPI): void {
  const usage = createUsageController(pi);

  pi.registerCommand("usage", {
    description: "Show subscription usage for supported providers",
    handler: (args, ctx) => usage.runCommand(args, ctx),
  });

  pi.on("session_start", (_event, ctx) => usage.start(ctx));
  pi.on("model_select", (event, ctx) => usage.trackModel(ctx, event.model));
  pi.on("agent_settled", (_event, ctx) => usage.trackModel(ctx, ctx.model));
  pi.on("session_shutdown", () => usage.dispose());
}
