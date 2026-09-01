import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { UsageControllerDependencies } from "./controller.js";
import { createUsageRuntime } from "./runtime.js";

export const createUsageExtension = (dependencies?: UsageControllerDependencies) =>
  function usageExtension(pi: ExtensionAPI): void {
    const runtime = createUsageRuntime(pi, dependencies);

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
  };

export default createUsageExtension();
