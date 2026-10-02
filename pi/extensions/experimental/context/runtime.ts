import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { observeRequest, type ObservedRequest } from "./observation.js";
import { ContextViews } from "./views.js";
import { OVERLAY_HEIGHT_RATIO } from "./render.js";
import { buildSnapshot } from "./snapshot.js";

export const createContextInspector = (pi: ExtensionAPI) => {
  // Only one overlay can exist: /context runs from the editor, which loses focus while it is open.
  let current: ContextViews | undefined;
  let captured: { sessionId: string; origin: string | null; request: ObservedRequest } | undefined;

  const dispose = (): void => {
    current?.dispose();
    current = undefined;
  };

  const reset = (): void => {
    dispose();
    captured = undefined;
  };

  const observe = (event: BeforeProviderRequestEvent, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    captured = {
      sessionId: ctx.sessionManager.getSessionId(),
      origin: ctx.sessionManager.getLeafId(),
      request: observeRequest(event.payload),
    };
  };

  const open = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/context requires TUI mode", "error");

      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const observation = captured;

    const request =
      observation?.sessionId === ctx.sessionManager.getSessionId() &&
      (observation.origin === null || branch.some((entry) => entry.id === observation.origin))
        ? observation.request
        : undefined;

    const snapshot = buildSnapshot({
      prompt: ctx.getSystemPrompt(),
      tools: pi.getAllTools(),
      activeTools: pi.getActiveTools(),
      branch,
      usage: ctx.getContextUsage(),
      modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
    });

    try {
      await ctx.ui.custom(
        (tui, theme, keybindings, done) => {
          current = new ContextViews(
            tui,
            theme,
            keybindings,
            snapshot,
            { kind: "request", request },
            ctx.ui,
            () => done(undefined),
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

  return { open, observe, reset };
};
