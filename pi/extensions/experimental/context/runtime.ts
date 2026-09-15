import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { ContextOverlay } from "./overlay.js";
import { OVERLAY_HEIGHT_RATIO } from "./render.js";
import { buildSnapshot } from "./snapshot.js";

export const createContextInspector = (pi: ExtensionAPI) => {
  // Only one overlay can exist: /context runs from the editor, which loses focus while it is open.
  let current: ContextOverlay | undefined;
  const dispose = (): void => {
    current?.dispose();
    current = undefined;
  };
  const open = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/context requires TUI mode", "error");
      return;
    }
    const snapshot = buildSnapshot({
      prompt: ctx.getSystemPrompt(),
      tools: pi.getAllTools(),
      activeTools: pi.getActiveTools(),
      branch: ctx.sessionManager.getBranch(),
      usage: ctx.getContextUsage(),
      modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
    });
    try {
      await ctx.ui.custom(
        (tui, theme, keybindings, done) => {
          current = new ContextOverlay(tui, theme, keybindings, snapshot, ctx.ui, () =>
            done(undefined),
          );
          return current;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            maxHeight: `${OVERLAY_HEIGHT_RATIO * 100}%`,
          },
          onHandle: (handle) => current?.attachMouse(handle),
        },
      );
    } finally {
      dispose();
    }
  };
  return { open, dispose };
};
