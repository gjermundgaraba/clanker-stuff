import {
  copyToClipboard,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import type {
  BeforeProviderRequestEvent,
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { observe } from "./observation.js";
import type { Observation } from "./observation.js";
import { OVERLAY_HEIGHT_RATIO } from "./render.js";
import { buildSnapshot } from "./snapshot.js";
import type { InputSnapshot, RequestSnapshot } from "./snapshot.js";
import { buildToolsSnapshot } from "./tools.js";
import { ContextViews } from "./views.js";

export const createContextInspector = (
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">
) => {
  let capturedInput: Observation | undefined;
  let capturedRequest: Observation | undefined;

  const reset = (): void => {
    capturedInput = undefined;
    capturedRequest = undefined;
  };

  const observeInput = (
    event: ContextWithSystemEvent,
    ctx: ExtensionContext
  ): void => {
    if (ctx.mode === "tui") {
      capturedRequest = undefined;
      capturedInput = observe(event.messages, "Pi input");
    }
  };

  const observeRequest = (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext
  ): void => {
    if (ctx.mode === "tui") {
      capturedRequest = observe(event.payload, "Provider payload");
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

    const request: RequestSnapshot = {
      kind: "request",
      request: capturedRequest,
    };

    const input: InputSnapshot = { kind: "input", input: capturedInput };
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
          input,
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

  return { open, observeInput, observeRequest, reset };
};
