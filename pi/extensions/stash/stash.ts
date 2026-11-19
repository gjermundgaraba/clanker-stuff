import type {
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";

import { popStash, pushStash } from "./storage.js";

const restoreDraft = (
  ctx: ExtensionContext,
  trigger: "automatic" | "manual"
): void => {
  let draft: string | undefined;

  try {
    draft = popStash(ctx.cwd);
  } catch {
    ctx.ui.notify("Could not restore stash.", "warning");

    return;
  }

  if (draft !== undefined) {
    ctx.ui.setEditorText(draft);
  } else if (trigger === "manual") {
    ctx.ui.notify("Nothing stashed.", "info");
  }
};

export const popStashCommand = async (
  _args: string,
  ctx: ExtensionContext
): Promise<void> => {
  if (ctx.mode !== "tui") {
    throw new Error("pop-stash requires the interactive terminal UI");
  }

  if (ctx.ui.getEditorText() !== "") {
    ctx.ui.notify(
      "Stash or clear the editor before restoring a draft.",
      "warning"
    );

    return;
  }

  restoreDraft(ctx, "manual");
};

export const autoRestoreStash = (
  event: InputEvent,
  ctx: ExtensionContext
): void => {
  if (
    event.source === "interactive" &&
    ctx.mode === "tui" &&
    ctx.ui.getEditorText() === ""
  ) {
    restoreDraft(ctx, "automatic");
  }
};

export const toggleStash = (ctx: ExtensionContext): void => {
  const text = ctx.ui.getEditorText();

  if (!text.trim()) {
    restoreDraft(ctx, "manual");

    return;
  }

  try {
    pushStash(ctx.cwd, text);
  } catch {
    ctx.ui.notify("Could not stash draft; editor text was kept.", "warning");

    return;
  }

  ctx.ui.setEditorText("");
  ctx.ui.notify("Stashed.", "info");
};
