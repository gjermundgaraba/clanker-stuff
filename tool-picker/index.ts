import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { persistToolsState, restoreEnabledTools } from "./state.js";
import { showToolsConfigurationUI } from "./tui.js";

export default function toolsExtension(pi: ExtensionAPI) {
  let enabledTools = new Set<string>();
  let baselineEnabledTools: Set<string> | undefined;

  const restoreFromBranch = (ctx: ExtensionContext) => {
    const allTools = pi.getAllTools();

    baselineEnabledTools ??= new Set(pi.getActiveTools());

    enabledTools = restoreEnabledTools(
      ctx,
      new Set(allTools.map((tool) => tool.name)),
      baselineEnabledTools
    );
    pi.setActiveTools([...enabledTools]);
  };

  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const allToolNames = new Set(allTools.map((tool) => tool.name));
      enabledTools = new Set(
        pi.getActiveTools().filter((toolName) => allToolNames.has(toolName))
      );

      await showToolsConfigurationUI(
        ctx,
        allTools,
        enabledTools,
        (toolName, enabled) => {
          if (enabled) {
            enabledTools.add(toolName);
          } else {
            enabledTools.delete(toolName);
          }

          pi.setActiveTools([...enabledTools]);
          persistToolsState(pi, enabledTools);
        }
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    baselineEnabledTools = undefined;
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });
}
