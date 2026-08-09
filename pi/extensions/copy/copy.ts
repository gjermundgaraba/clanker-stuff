import { copyToClipboard, CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];
type AssistantEntry = Extract<SessionEntry, { type: "message" }> & {
  message: Extract<SessionMessage, { role: "assistant" }>;
};

const getLastAssistantText = (ctx: ExtensionContext): string | undefined => {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (candidate): candidate is AssistantEntry =>
        candidate.type === "message" &&
        candidate.message.role === "assistant" &&
        (candidate.message.stopReason !== "aborted" ||
          candidate.message.content.length > 0)
    );
  if (!entry) {
    return undefined;
  }
  return (
    entry.message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim() || undefined
  );
};

const copyLastAssistantMessage = async (
  ctx: ExtensionContext
): Promise<void> => {
  const text = getLastAssistantText(ctx);
  if (text === undefined) {
    ctx.ui.notify("No agent messages to copy yet.", "error");
    return;
  }

  try {
    await copyToClipboard(text);
    ctx.ui.notify("Copied last agent message to clipboard.", "info");
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error"
    );
  }
};

const interceptCopy = (
  base: EditorComponent,
  ctx: ExtensionContext
): EditorComponent => {
  let { onSubmit } = base;
  Object.defineProperty(base, "onSubmit", {
    configurable: true,
    enumerable: true,
    get: () => onSubmit,
    set: (submit: EditorComponent["onSubmit"]) => {
      onSubmit = submit
        ? (text) => {
            if (text.trim() !== "/copy") {
              submit.call(base, text);
              return;
            }
            base.setText("");
            void copyLastAssistantMessage(ctx);
          }
        : undefined;
    },
  });
  return base;
};

export const installCopy = (ctx: ExtensionContext): void => {
  const previous = ctx.ui.getEditorComponent();
  ctx.ui.setEditorComponent((tui, theme, keybindings) =>
    interceptCopy(
      previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings),
      ctx
    )
  );
};
