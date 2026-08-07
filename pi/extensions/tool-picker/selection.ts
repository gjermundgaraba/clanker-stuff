import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { showToolsConfigurationUI } from "./picker.js";
import { persistToolsState, restoreEnabledTools } from "./state.js";

export const createToolSelection = (pi: ExtensionAPI) => {
  let baselineEnabledTools: Set<string> | undefined;

  const restore = (ctx: ExtensionContext): void => {
    baselineEnabledTools ??= new Set(pi.getActiveTools());
    const enabledTools = restoreEnabledTools(
      ctx,
      new Set(pi.getAllTools().map((tool) => tool.name)),
      baselineEnabledTools
    );
    pi.setActiveTools([...enabledTools]);
  };

  return {
    async open(ctx: ExtensionCommandContext): Promise<void> {
      const enabledTools = new Set(pi.getActiveTools());

      await showToolsConfigurationUI(
        ctx,
        pi.getAllTools(),
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
    restore,
    start(ctx: ExtensionContext): void {
      baselineEnabledTools = undefined;
      restore(ctx);
    },
  };
};
