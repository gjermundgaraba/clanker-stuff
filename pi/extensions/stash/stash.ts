import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import {
  copyToClipboard,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

const MAX_STASHES = 10;

interface StashStore {
  entries: Record<string, string[]>;
}

const getStorePath = () =>
  path.join(getExtensionStoragePaths("stash").dataDir, "state.json");

const emptyStore = (): StashStore => ({ entries: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStore = (data: unknown): StashStore => {
  if (!isRecord(data) || !isRecord(data.entries)) {
    return emptyStore();
  }

  const parsed = emptyStore();
  for (const [key, value] of Object.entries(data.entries)) {
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      parsed.entries[key] = value;
    }
  }
  return parsed;
};

const readStore = async (filePath: string): Promise<StashStore> => {
  try {
    return parseStore(JSON.parse(await readFile(filePath, "utf-8")));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return emptyStore();
    }
    if (error instanceof SyntaxError) {
      return emptyStore();
    }
    throw error;
  }
};

const writeStore = async (filePath: string, store: StashStore) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  await rename(tempPath, filePath);
};

const copyStashedText = async (ctx: ExtensionContext, text: string) => {
  try {
    await copyToClipboard(text);
    ctx.ui.notify("Copied stash to clipboard.", "info");
  } catch {
    ctx.ui.notify("Failed to copy stash to clipboard.", "warning");
  }
};

export const createStash = () => {
  const stack: string[] = [];
  let pendingRestore = false;
  let cancelPendingCopy: (() => void) | undefined;

  const trimStack = () => {
    stack.splice(0, Math.max(0, stack.length - MAX_STASHES));
  };

  const loadStack = async (ctx: ExtensionContext) => {
    try {
      const store = await readStore(getStorePath());
      const storedStack = store.entries[ctx.cwd] ?? [];
      stack.splice(0, stack.length, ...storedStack);
      trimStack();
    } catch {
      stack.splice(0);
      ctx.ui.notify("Failed to load persisted stash.", "warning");
    }
  };

  const saveStack = async (ctx: ExtensionContext) => {
    try {
      const filePath = getStorePath();
      await withFileMutationQueue(filePath, async () => {
        const store = await readStore(filePath);
        if (stack.length === 0) {
          const { [ctx.cwd]: _removed, ...rest } = store.entries;
          store.entries = rest;
        } else {
          store.entries[ctx.cwd] = [...stack];
        }
        await writeStore(filePath, store);
      });
    } catch {
      ctx.ui.notify("Failed to persist stash.", "warning");
    }
  };

  const clearPendingCopy = (ctx: ExtensionContext) => {
    cancelPendingCopy?.();
    cancelPendingCopy = undefined;
    ctx.ui.setStatus("stash:copy", undefined);
  };

  const armPendingCopy = (ctx: ExtensionContext, text: string) => {
    clearPendingCopy(ctx);
    ctx.ui.setStatus("stash:copy", "press c to copy stash");

    cancelPendingCopy = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || isKeyRepeat(data)) {
        return {};
      }

      clearPendingCopy(ctx);

      if (matchesKey(data, "c")) {
        void copyStashedText(ctx, text);
        return { consume: true };
      }

      return {};
    });
  };

  const popIntoEditor = (ctx: ExtensionContext) => {
    const popped = stack.pop();
    if (popped === undefined) {
      return false;
    }

    ctx.ui.setEditorText(popped);
    return true;
  };

  const toggle = async (ctx: ExtensionContext) => {
    const text = ctx.ui.getEditorText();
    if (!text.trim()) {
      clearPendingCopy(ctx);
      if (!popIntoEditor(ctx)) {
        ctx.ui.notify("Nothing stashed.", "info");
        return;
      }
      pendingRestore = false;
      await saveStack(ctx);
      return;
    }

    stack.push(text);
    trimStack();
    ctx.ui.setEditorText("");
    armPendingCopy(ctx, text);
    ctx.ui.notify(
      `Stashed (${stack.length}). Press c to copy to clipboard.`,
      "info"
    );
    await saveStack(ctx);
  };

  const pop = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      throw new Error("pop-stash requires interactive UI");
    }

    if (!popIntoEditor(ctx)) {
      ctx.ui.notify("Nothing stashed.", "info");
      return;
    }

    pendingRestore = false;
    await saveStack(ctx);
  };

  const prepareRestore = (
    event: InputEvent,
    ctx: ExtensionContext
  ): InputEventResult => {
    if (event.source !== "interactive") {
      return { action: "continue" };
    }

    // Peek at stashed text and update the editor, but defer the actual
    // pop() until turn_start confirms the turn is actually proceeding.
    // This prevents losing the stash when a later extension returns
    // { action: "handled" } and the agent never runs.
    const peeked = stack.at(-1);
    if (peeked !== undefined) {
      pendingRestore = true;
      ctx.ui.setEditorText(peeked);
    }

    return { action: "continue" };
  };

  const commitRestore = async (ctx: ExtensionContext) => {
    if (!pendingRestore) {
      return;
    }

    pendingRestore = false;
    stack.pop();
    await saveStack(ctx);
  };

  return {
    commitRestore,
    dispose: clearPendingCopy,
    pop,
    prepareRestore,
    start: loadStack,
    toggle,
  };
};
