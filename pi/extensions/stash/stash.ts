import type {
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";

import { LegacyStashError, popStash, pushStash } from "./storage.js";

const warnOnStorageFailure = (
  ctx: ExtensionContext,
  message: string,
  error: unknown
): void => {
  const detail = error instanceof LegacyStashError ? ` ${error.message}` : "";
  ctx.ui.notify(`${message}${detail}`, "warning");
};

const restoreDraft = (
  ctx: ExtensionContext,
  trigger: "automatic" | "manual"
): void => {
  let draft: string | undefined;

  try {
    draft = popStash(ctx.cwd);
  } catch (error) {
    warnOnStorageFailure(ctx, "Could not restore stash.", error);

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
  if (!ctx.hasUI || ctx.mode !== "tui") {
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
    ctx.hasUI &&
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

  let count: number;

  try {
    count = pushStash(ctx.cwd, text);
  } catch (error) {
    warnOnStorageFailure(
      ctx,
      "Could not stash draft; editor text was kept.",
      error
    );

    return;
  }

  ctx.ui.setEditorText("");
  ctx.ui.notify(`Stashed (${count}).`, "info");
};
