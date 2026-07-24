import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import * as Clipboard from "@mariozechner/clipboard";

const MAX_STASHES = 10;

interface StashStore {
  entries: Record<string, { stack: string[] }>;
}

const getStorePath = () => path.join(getAgentDir(), "stash", "state.json");

const getStoreKey = (ctx: ExtensionContext) => `cwd:${ctx.cwd}`;

const emptyStore = (): StashStore => ({ entries: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    await Clipboard.setText(text);
    ctx.ui.notify("Copied stash to clipboard.", "info");
  } catch {
    ctx.ui.notify("Failed to copy stash to clipboard.", "warning");
  }
};

export default function stash(pi: ExtensionAPI) {
  const stack: string[] = [];
  let pendingRestore = false;
  let cancelPendingCopy: (() => void) | undefined;

  const trimStack = () => {
    stack.splice(0, Math.max(0, stack.length - MAX_STASHES));
  };

  const parseStore = (data: unknown): StashStore => {
    if (!isRecord(data) || !isRecord(data.entries)) {
      return emptyStore();
    }

    const parsed = emptyStore();
    for (const [key, value] of Object.entries(data.entries)) {
      if (
        isRecord(value) &&
        Array.isArray(value.stack) &&
        value.stack.every((item) => typeof item === "string")
      ) {
        parsed.entries[key] = { stack: [...value.stack] };
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

  const loadStack = async (ctx: ExtensionContext) => {
    try {
      const store = await readStore(getStorePath());
      const storedStack = store.entries[getStoreKey(ctx)]?.stack ?? [];
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
        const key = getStoreKey(ctx);
        if (stack.length === 0) {
          const { [key]: _removed, ...rest } = store.entries;
          store.entries = rest;
        } else {
          store.entries[key] = { stack: [...stack] };
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

  const popIntoEditor = (ctx: { ui: ExtensionCommandContext["ui"] }) => {
    const popped = stack.pop();
    if (popped === undefined) {
      return false;
    }

    ctx.ui.setEditorText(popped);
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    await loadStack(ctx);
  });

  pi.registerShortcut("ctrl+s", {
    description:
      "Stash current editor text, or pop the latest stash when empty",
    handler: async (ctx: ExtensionContext) => {
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
    },
  });

  pi.registerCommand("pop-stash", {
    description: "Pop the most recent stashed editor text",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("pop-stash requires interactive UI");
      }

      if (!popIntoEditor(ctx)) {
        ctx.ui.notify("Nothing stashed.", "info");
        return;
      }

      pendingRestore = false;
      await saveStack(ctx);
    },
  });

  pi.on("input", (event, ctx): InputEventResult => {
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
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (pendingRestore) {
      pendingRestore = false;
      if (stack.length > 0) {
        stack.pop();
      }
      await saveStack(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearPendingCopy(ctx);
  });
}
