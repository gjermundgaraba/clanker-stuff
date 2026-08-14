import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createUsageRuntime } from "./runtime.js";

export default function usageExtension(pi: ExtensionAPI): void {
  const runtime = createUsageRuntime(pi);

  pi.registerCommand("usage", {
    description: "Show subscription usage for supported providers",
    handler: (args, ctx) => runtime.runCommand(args, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.sessionStart(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    runtime.trackModel(ctx, event.model);
  });
  pi.on("agent_settled", (_event, ctx) => {
    runtime.trackModel(ctx, ctx.model);
  });
  pi.on("session_shutdown", () => runtime.shutdown());
}
