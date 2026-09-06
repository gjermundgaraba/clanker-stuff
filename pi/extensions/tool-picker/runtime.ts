import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createToolSelection } from "./selection.js";
import type { ToolStates } from "./selection.js";

export const createToolPicker = (pi: ExtensionAPI) => {
  const selection = createToolSelection(pi);
  const apply = (states: ToolStates): void => {
    const active = new Set(pi.getActiveTools());
    pi.setActiveTools(
      pi
        .getAllTools()
        .map(({ name }) => name)
        .filter((name) => states[name] ?? active.has(name)),
    );
  };

  return {
    async open(ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }
      const { showToolsPicker } = await import("./picker.js");
      await showToolsPicker(
        ctx,
        pi.getAllTools(),
        new Set(pi.getActiveTools()),
        (name, enabled) => {
          const active = new Set(pi.getActiveTools());
          if (enabled) {
            active.add(name);
          } else {
            active.delete(name);
          }
          pi.setActiveTools([...active]);
          selection.save(ctx);
        },
      );
    },
    restore(ctx: ExtensionContext): void {
      apply(selection.restore(ctx));
    },
    start(ctx: ExtensionContext): void {
      apply(selection.start(ctx));
    },
  };
};
