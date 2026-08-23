import { STATIC_BREATHING_DOT_FRAME } from "@clanker-stuff/pi-motion";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

import { SidePanel } from "./panel.js";
import { createSideConversation, isSideActivityActive } from "./session.js";
import type { SideSessionController } from "./session.js";

const SIDE_STATUS_KEY = "side";
const SIDE_WIDE_COLUMNS = 120;

interface ActiveSide {
  context: ExtensionContext;
  conversation: SideSessionController;
  disposed: boolean;
  finish?: () => void;
  handle?: OverlayHandle;
  hidden: boolean;
  panel?: SidePanel;
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
  } else if (side.hidden) {
    color = "dim";
    label = "hidden";
  }
  const frame = STATIC_BREATHING_DOT_FRAME;
  const { theme } = side.context.ui;
  side.context.ui.setStatus(
    SIDE_STATUS_KEY,
    `${theme.fg(color, "SIDE ")}${theme.fg(frame.color, frame.marker)}${theme.fg(color, ` ${label}`)}`
  );
};

const restore = (side: ActiveSide): void => {
  side.hidden = false;
  side.handle?.setHidden(false);
  side.handle?.focus();
};

export const createSideController = (pi: ExtensionAPI) => {
  let lifecycle: ControllerLifecycle = { kind: "idle" };

  const activeSide = (): ActiveSide | undefined =>
    lifecycle.kind === "active" ? lifecycle.side : undefined;

  const hide = (side: ActiveSide): void => {
    side.hidden = true;
    side.handle?.setHidden(true);
    updateStatus(side);
  };

  const insertLatest = (side: ActiveSide): void => {
    const text = side.conversation.latestAssistantText();
    if (text === undefined) {
      side.context.ui.notify(
        "Side has no completed response to insert.",
        "warning"
      );
      return;
    }
    hide(side);
    side.context.ui.pasteToEditor(text);
    side.context.ui.notify("Inserted the latest side response.", "info");
  };

  const toggleFocus = (side: ActiveSide): void => {
    if (side.hidden) {
      restore(side);
      return;
    }
    if (side.handle?.isFocused() === true) {
      side.handle.unfocus();
      return;
    }
    side.handle?.focus();
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
    side.finish?.();
    side.handle?.hide();
    side.context.ui.setStatus(SIDE_STATUS_KEY, undefined);
    await side.conversation.dispose();
  };

  const openSide = async (
    args: string,
    ctx: ExtensionContext
  ): Promise<void> => {
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
      restore(active);
      if (prompt) {
        active.panel?.submitExternalPrompt(prompt);
      }
      return;
    }
    if (lifecycle.kind === "opening") {
      ctx.ui.notify(
        "Side is still opening. Use its editor once ready.",
        "info"
      );
      return;
    }
    if (lifecycle.kind === "stopped") {
      return;
    }

    const opening = { context: ctx, kind: "opening" } as const;
    lifecycle = opening;
    ctx.ui.setStatus(
      SIDE_STATUS_KEY,
      ctx.ui.theme.fg("warning", "SIDE ● opening")
    );

    let conversation: SideSessionController;
    try {
      conversation = await createSideConversation(ctx, pi.getThinkingLevel());
    } catch (error) {
      if (lifecycle === opening) {
        lifecycle = { kind: "idle" };
        ctx.ui.setStatus(SIDE_STATUS_KEY, undefined);
        ctx.ui.notify(
          `Failed to open side: ${error instanceof Error ? error.message : String(error)}`,
          "error"
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
      hidden: false,
      unread: false,
    };
    lifecycle = { kind: "active", side };

    side.unsubscribe = conversation.subscribe(() => {
      if (
        !isSideActivityActive(conversation.state.activity) &&
        (side.hidden || side.handle?.isFocused() !== true)
      ) {
        side.unread = true;
      }
      updateStatus(side);
    });
    updateStatus(side);

    let tuiRef: TUI | undefined;
    try {
      await ctx.ui.custom<null>(
        (tui, theme, keybindings, done) => {
          tuiRef = tui;
          side.finish = () => {
            done(null);
          };
          side.panel = new SidePanel(tui, theme, keybindings, conversation, {
            getMainWorking: () => !ctx.isIdle(),
            getWorkingMarker: () => {
              const frame = STATIC_BREATHING_DOT_FRAME;
              return theme.fg(frame.color, frame.marker);
            },
            onClose: () => {
              side.finish?.();
            },
            onFocus: () => {
              side.unread = false;
              updateStatus(side);
            },
            onHide: () => {
              hide(side);
            },
            onInsertLatest: () => {
              insertLatest(side);
            },
            onToggleFocus: () => {
              toggleFocus(side);
            },
          });
          if (prompt) {
            side.panel.submitExternalPrompt(prompt);
          }
          return side.panel;
        },
        {
          onHandle: (handle) => {
            side.handle = handle;
            handle.focus();
          },
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            nonCapturing: true,
            get width() {
              return (tuiRef?.terminal.columns ?? 0) >= SIDE_WIDE_COLUMNS
                ? "50%"
                : "100%";
            },
          },
        }
      );
    } finally {
      await disposeSide(side);
    }
  };

  const launch = (args: string, ctx: ExtensionContext): Promise<void> => {
    void (async () => {
      try {
        await openSide(args, ctx);
      } catch (error) {
        ctx.ui.setStatus(SIDE_STATUS_KEY, undefined);
        ctx.ui.notify(
          `Side failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
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
      if (active) {
        toggleFocus(active);
        return Promise.resolve();
      }
      return launch("", ctx);
    },
  };
};
