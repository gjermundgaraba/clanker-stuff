import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Key } from "@earendil-works/pi-tui";

import { SidePanel } from "./panel.js";
import { createSideConversation } from "./session.js";
import type { SideSessionController } from "./session.js";

const SIDE_STATUS_KEY = "side";
const SIDE_WIDE_COLUMNS = 120;

interface ActiveSide {
  context: ExtensionContext;
  conversation: SideSessionController;
  finish?: () => void;
  handle?: OverlayHandle;
  hidden: boolean;
  panel?: SidePanel;
  unread: boolean;
  unsubscribe?: () => void;
}

const updateStatus = (side: ActiveSide): void => {
  let color: "accent" | "dim" | "success" | "warning" = "accent";
  let label = "active";
  if (side.conversation.state.isRunning) {
    color = "warning";
    label = "working";
  } else if (side.unread) {
    color = "success";
    label = "done";
  } else if (side.hidden) {
    color = "dim";
    label = "hidden";
  }
  side.context.ui.setStatus(
    SIDE_STATUS_KEY,
    side.context.ui.theme.fg(color, `SIDE • ${label}`)
  );
};

const restore = (side: ActiveSide): void => {
  side.hidden = false;
  side.handle?.setHidden(false);
  side.handle?.focus();
};

export default function sideExtension(pi: ExtensionAPI): void {
  let active: ActiveSide | undefined;
  let opening = false;
  let sessionGeneration = 0;

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
    side.unsubscribe?.();
    side.unsubscribe = undefined;
    side.finish?.();
    side.handle?.hide();
    await side.conversation.dispose();
    if (active === side) {
      active = undefined;
    }
    side.context.ui.setStatus(SIDE_STATUS_KEY, undefined);
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
    if (active) {
      restore(active);
      if (prompt) {
        active.panel?.submitExternalPrompt(prompt);
      }
      return;
    }
    if (opening) {
      ctx.ui.notify(
        "Side is still opening. Use its editor once ready.",
        "info"
      );
      return;
    }

    opening = true;
    const openingGeneration = sessionGeneration;
    ctx.ui.setStatus(
      SIDE_STATUS_KEY,
      ctx.ui.theme.fg("warning", "SIDE • opening")
    );

    let conversation: SideSessionController;
    try {
      conversation = await createSideConversation(ctx, pi.getThinkingLevel());
    } catch (error) {
      opening = false;
      ctx.ui.setStatus(SIDE_STATUS_KEY, undefined);
      ctx.ui.notify(
        `Failed to open side: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return;
    }
    opening = false;

    if (openingGeneration !== sessionGeneration) {
      await conversation.dispose();
      return;
    }

    const side: ActiveSide = {
      context: ctx,
      conversation,
      hidden: false,
      unread: false,
    };
    active = side;

    side.unsubscribe = conversation.subscribe(() => {
      if (
        !conversation.state.isRunning &&
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

  const launchSide = (args: string, ctx: ExtensionContext): Promise<void> => {
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

  pi.registerCommand("side", {
    description: "Open or restore a concurrent multi-turn side conversation",
    handler: launchSide,
  });

  pi.registerShortcut(Key.ctrl("/"), {
    description: "Open side or toggle focus between side and main",
    handler: (ctx) => {
      if (active) {
        toggleFocus(active);
        return Promise.resolve();
      }
      return launchSide("", ctx);
    },
  });

  pi.on("session_start", () => {
    sessionGeneration += 1;
  });

  pi.on("session_tree", async (_event, ctx) => {
    sessionGeneration += 1;
    if (!active) {
      return;
    }
    ctx.ui.notify("Closed side because the main branch changed.", "info");
    await disposeSide(active);
  });

  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    if (active) {
      await disposeSide(active);
    }
  });
}
