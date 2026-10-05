import type {
  BeforeProviderRequestEvent,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { observeRequest, type ObservedRequest } from "./observation.js";
import { ContextViews } from "./views.js";
import { OVERLAY_HEIGHT_RATIO } from "./render.js";
import { buildSnapshot } from "./snapshot.js";

export const createContextInspector = () => {
  // Session start and tree navigation reset it, so it always belongs to the current branch.
  let captured: ObservedRequest | undefined;

  const reset = (): void => {
    captured = undefined;
  };

  const observe = (event: BeforeProviderRequestEvent, ctx: ExtensionContext): void => {
    // Only TUI mode can open the inspector; skip per-request serialization everywhere else.
    if (ctx.mode === "tui") captured = observeRequest(event.payload);
  };

  const open = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/context requires TUI mode", "error");

      return;
    }

    const snapshot = buildSnapshot({
      pendingPrompt: ctx.getSystemPrompt(),
      branch: ctx.sessionManager.getBranch(),
      usage: ctx.getContextUsage(),
      modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
    });

    const request = captured;

    await ctx.ui.custom(
      (tui, theme, keybindings, done) =>
        new ContextViews(
          tui,
          theme,
          keybindings,
          snapshot,
          { kind: "request", request },
          ctx.ui,
          () => done(undefined),
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: `${OVERLAY_HEIGHT_RATIO * 100}%`,
        },
      },
    );
  };

  return { open, observe, reset };
};
