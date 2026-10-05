import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const MAX_STASHES = 10;

const StashFileSchema = Type.Object({ entries: Type.Array(Type.String()) });

const getStorePath = (cwd: string) =>
  path.join(
    getExtensionStoragePaths("stash").dataDir,
    `${createHash("sha256").update(path.resolve(cwd)).digest("hex")}.json`,
  );

const readStore = async (filePath: string): Promise<string[]> => {
  try {
    const data: unknown = JSON.parse(await readFile(filePath, "utf-8"));

    return Value.Check(StashFileSchema, data) ? data.entries : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];

    if (error instanceof Object && "code" in error && error.code === "ENOENT") return [];

    throw error;
  }
};

/** A per-project stack of stashed drafts; the newest is restored after the next submitted prompt. */
export const createStash = () => {
  const stack: string[] = [];
  let pendingSave = Promise.resolve();

  const load = async (ctx: ExtensionContext) => {
    try {
      stack.splice(
        0,
        stack.length,
        ...(await readStore(getStorePath(ctx.cwd))).slice(-MAX_STASHES),
      );
    } catch {
      stack.splice(0);
      ctx.ui.notify("Failed to load persisted stash.", "warning");
    }
  };

  const save = async (ctx: ExtensionContext) => {
    const filePath = getStorePath(ctx.cwd);
    const content = `${JSON.stringify({ entries: [...stack] }, null, 2)}\n`;

    // Atomic replacement: an interrupted write must not leave a truncated store.
    pendingSave = withFileMutationQueue(filePath, async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp-${randomUUID()}`;
      await writeFile(tempPath, content, "utf-8");
      await rename(tempPath, filePath);
    }).catch(() => {
      ctx.ui.notify("Failed to persist stash.", "warning");
    });
    await pendingSave;
  };

  const pop = async (ctx: ExtensionContext) => {
    const popped = stack.pop();

    if (popped === undefined) {
      ctx.ui.notify("Nothing stashed.", "info");

      return;
    }

    ctx.ui.setEditorText(popped);
    await save(ctx);
  };

  const toggle = async (ctx: ExtensionContext) => {
    const text = ctx.ui.getEditorText();

    if (!text.trim()) {
      await pop(ctx);

      return;
    }

    stack.push(text);
    stack.splice(0, Math.max(0, stack.length - MAX_STASHES));
    ctx.ui.setEditorText("");
    ctx.ui.notify(`Stashed (${stack.length}).`, "info");
    await save(ctx);
  };

  const popCommand = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) throw new Error("pop-stash requires interactive UI");
    await pop(ctx);
  };

  const restore = async (event: InputEvent, ctx: ExtensionContext) => {
    if (event.source !== "interactive" || ctx.mode !== "tui" || stack.length === 0) return;
    await pop(ctx);
  };

  return {
    dispose: () => pendingSave,
    pop: popCommand,
    restore,
    start: load,
    toggle,
  };
};
