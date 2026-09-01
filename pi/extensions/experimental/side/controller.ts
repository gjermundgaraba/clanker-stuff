import { STATIC_BREATHING_DOT_FRAME } from "@clanker-stuff/pi-motion";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";

import { SidePanel } from "./panel.js";
import { createSideConversation, isSideActivityActive } from "./session.js";
import type { SideConversation } from "./session.js";

const SIDE_STATUS_KEY = "side";
const SIDE_WIDE_COLUMNS = 120;

interface SidePresentation {
  handle?: OverlayHandle;
  panel?: SidePanel;
}

interface ActiveSide {
  context: ExtensionContext;
  conversation: SideConversation;
  disposed: boolean;
  draft: string;
  presentation?: SidePresentation;
  unread: boolean;
  unsubscribe?: () => void;
}

type ControllerLifecycle =
  | { kind: "idle" }
  | { context: ExtensionContext; kind: "opening" }
  | { kind: "active"; side: ActiveSide }
  | { kind: "stopped" };

const updateStatus = (side: ActiveSide): void => {
  let color: "accent" | "dim" | "success" | "warning" = "accent";
  let label = "active";
  if (isSideActivityActive(side.conversation.state.activity)) {
    color = "warning";
    label = "working";
  } else if (side.unread) {
    color = "success";
    label = "done";
  } else if (!side.presentation) {
    color = "dim";
    label = "background";
  }
  const frame = STATIC_BREATHING_DOT_FRAME;
  const { theme } = side.context.ui;
  side.context.ui.setStatus(
    SIDE_STATUS_KEY,
    `${theme.fg(color, "SIDE ")}${theme.fg(frame.color, frame.marker)}${theme.fg(color, ` ${label}`)}`,
  );
};

export const createSideController = (pi: ExtensionAPI) => {
  let lifecycle: ControllerLifecycle = { kind: "idle" };

  const activeSide = (): ActiveSide | undefined =>
    lifecycle.kind === "active" ? lifecycle.side : undefined;

  const dismissPresentation = (side: ActiveSide): void => {
    const presentation = side.presentation;
    if (!presentation) {
      return;
    }
    side.presentation = undefined;
    if (presentation.panel) {
      side.draft = presentation.panel.getDraft();
    }
    presentation.handle?.hide();
    presentation.panel?.dispose();
    updateStatus(side);
  };

  const insertLatest = (side: ActiveSide): void => {
    const text = side.conversation.latestAssistantText();
    if (text === undefined) {
      side.context.ui.notify("Side has no completed response to insert.", "warning");
      return;
    }
    dismissPresentation(side);
    side.context.ui.pasteToEditor(text);
    side.context.ui.notify("Inserted the latest side response.", "info");
  };

  const disposeSide = async (side: ActiveSide): Promise<void> => {
    // Clear shared state before the awaited teardown so a /side issued while
    // the old conversation is still disposing opens a fresh side.
    if (side.disposed) {
      return;
    }
    side.disposed = true;
    if (lifecycle.kind === "active" && lifecycle.side === side) {
      lifecycle = { kind: "idle" };
    }
    side.unsubscribe?.();
    side.unsubscribe = undefined;
    dismissPresentation(side);
    side.context.ui.setStatus(SIDE_STATUS_KEY, undefined);
    await side.conversation.dispose();
  };

  const presentSide = async (side: ActiveSide, prompt: string): Promise<void> => {
    const current = side.presentation;
    if (current) {
      if (prompt) {
        current.panel?.submitExternalPrompt(prompt);
      }
      return;
    }

    const presentation: SidePresentation = {};
    side.presentation = presentation;
    updateStatus(side);

    try {
      await side.context.ui.custom<null>((tui, theme, keybindings, done) => {
        const panel = new SidePanel(
          tui,
          theme,
          keybindings,
          side.conversation,
          {
            getMainWorking: () => !side.context.isIdle(),
            getWorkingMarker: () => {
              const frame = STATIC_BREATHING_DOT_FRAME;
              return theme.fg(frame.color, frame.marker);
            },
            onClose: () => {
              void (async () => {
                try {
                  await disposeSide(side);
                } catch (error) {
                  side.context.ui.notify(
                    `Side failed to close: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                  );
                }
              })();
            },
            onDismiss: () => {
              dismissPresentation(side);
            },
            onInsertLatest: () => {
              insertLatest(side);
            },
          },
          side.draft,
        );
        presentation.panel = panel;
        if (prompt) {
          panel.submitExternalPrompt(prompt);
        }
        // Own the overlay so Pi's custom-prompt span ends while the main agent keeps running.
        const handle = tui.showOverlay(panel, {
          anchor: "top-right",
          get width() {
            return tui.terminal.columns >= SIDE_WIDE_COLUMNS ? "50%" : "100%";
          },
        });
        presentation.handle = handle;
        side.unread = false;
        updateStatus(side);
        done(null);
        handle.focus();
        return panel;
      });
    } catch (error) {
      if (side.presentation === presentation) {
        dismissPresentation(side);
      }
      throw error;
    }
  };

  const openSide = async (args: string, ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/side requires interactive TUI mode.", "warning");
      return;
    }
    if (!ctx.model) {
      ctx.ui.notify("/side requires an active model.", "error");
      return;
    }

    const prompt = args.trim();
    const active = activeSide();
    if (active) {
      await presentSide(active, prompt);
      return;
    }
    if (lifecycle.kind === "opening") {
      ctx.ui.notify("Side is still opening. Use its editor once ready.", "info");
      return;
    }
    if (lifecycle.kind === "stopped") {
      return;
    }

    const opening = { context: ctx, kind: "opening" } as const;
    lifecycle = opening;
    ctx.ui.setStatus(SIDE_STATUS_KEY, ctx.ui.theme.fg("warning", "SIDE ● opening"));

    let conversation: SideConversation;
    try {
      conversation = await createSideConversation(ctx, pi.getThinkingLevel());
    } catch (error) {
      if (lifecycle === opening) {
        lifecycle = { kind: "idle" };
        ctx.ui.setStatus(SIDE_STATUS_KEY, undefined);
        ctx.ui.notify(
          `Failed to open side: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return;
    }

    if (lifecycle !== opening) {
      await conversation.dispose();
      return;
    }

    const side: ActiveSide = {
      context: ctx,
      conversation,
      disposed: false,
      draft: "",
      unread: false,
    };
    lifecycle = { kind: "active", side };

    side.unsubscribe = conversation.subscribe(() => {
      if (!isSideActivityActive(conversation.state.activity) && !side.presentation) {
        side.unread = true;
      }
      updateStatus(side);
    });
    updateStatus(side);
    await presentSide(side, prompt);
  };

  const launch = (args: string, ctx: ExtensionContext): Promise<void> => {
    void (async () => {
      try {
        await openSide(args, ctx);
      } catch (error) {
        const active = activeSide();
        if (active) {
          updateStatus(active);
        } else {
          ctx.ui.setStatus(SIDE_STATUS_KEY, undefined);
        }
        ctx.ui.notify(
          `Side failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    })();
    return Promise.resolve();
  };

  return {
    closeOnTreeChange: async (ctx: ExtensionContext): Promise<void> => {
      if (lifecycle.kind === "opening") {
        lifecycle = { kind: "idle" };
        ctx.ui.setStatus(SIDE_STATUS_KEY, undefined);
        return;
      }
      const active = activeSide();
      if (!active) {
        return;
      }
      ctx.ui.notify("Closed side because the main branch changed.", "info");
      await disposeSide(active);
    },
    dispose: async (): Promise<void> => {
      const previous = lifecycle;
      const active = activeSide();
      lifecycle = { kind: "stopped" };
      if (previous.kind === "opening") {
        previous.context.ui.setStatus(SIDE_STATUS_KEY, undefined);
      }
      if (!active) {
        return;
      }
      await disposeSide(active);
    },
    launch,
    toggle: (ctx: ExtensionContext): Promise<void> => {
      const active = activeSide();
      if (active?.presentation) {
        dismissPresentation(active);
        return Promise.resolve();
      }
      return launch("", ctx);
    },
  };
};
