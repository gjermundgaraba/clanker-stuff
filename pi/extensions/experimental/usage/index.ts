import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { completeUsageArgs } from "./command.js";
import type { UsageControllerDependencies } from "./controller.js";
import { createUsageRuntime } from "./runtime.js";
import type { LoadUsageController } from "./runtime.js";

const loadUsageController: LoadUsageController = async () => {
  const { createUsageController } = await import("./controller.js");

  return createUsageController;
};

export const createUsageExtension = (
  dependencies?: UsageControllerDependencies,
  loadController: LoadUsageController = loadUsageController
) =>
  function usageExtension(pi: ExtensionAPI): void {
    const runtime = createUsageRuntime(loadController, dependencies);

    pi.registerCommand("usage", {
      description: "Show account usage for supported providers",
      getArgumentCompletions: completeUsageArgs,
      handler: runtime.runCommand,
    });

    pi.on("session_start", (_event, ctx) => {
      runtime.sessionStart(ctx);
    });
    pi.on("model_select", (_event, ctx) => {
      runtime.refresh(ctx);
    });
    pi.on("turn_end", (_event, ctx) => {
      runtime.refresh(ctx);
    });
    pi.on("agent_settled", (_event, ctx) => {
      runtime.refresh(ctx);
    });
    pi.on("session_tree", (_event, ctx) => {
      runtime.refresh(ctx);
    });
    pi.on("session_shutdown", async () => {
      await runtime.shutdown();
    });
  };

export default createUsageExtension();
