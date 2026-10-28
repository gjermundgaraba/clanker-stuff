import {
  copyToClipboard,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { observeRequest } from "./observation.js";
import type { ObservedRequest } from "./observation.js";
import { OVERLAY_HEIGHT_RATIO } from "./render.js";
import { buildSnapshot } from "./snapshot.js";
import type { RequestSnapshot } from "./snapshot.js";
import { buildToolsSnapshot } from "./tools.js";
import { ContextViews } from "./views.js";

export const createContextInspector = (
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">
) => {
  let captured: ObservedRequest | undefined;

  const reset = (): void => {
    captured = undefined;
  };

  const observe = (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext
  ): void => {
    if (ctx.mode === "tui") {
      captured = observeRequest(event.payload);
    }
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
      modelLabel: ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unknown model",
    });

    const request: RequestSnapshot = { kind: "request", request: captured };
    const tools = buildToolsSnapshot(pi.getAllTools(), pi.getActiveTools());

    await ctx.ui.custom(
      (tui, theme, keybindings, done) =>
        new ContextViews(
          tui,
          theme,
          keybindings,
          snapshot,
          request,
          tools,
          ctx.ui,
          { copyToClipboard, highlightCode },
          () => {
            done(undefined);
          }
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: `${OVERLAY_HEIGHT_RATIO * 100}%`,
        },
      }
    );
  };

  return { open, observe, reset };
};
