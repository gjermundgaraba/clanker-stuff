import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const MAX_STASHES = 10;

const StashFileSchema = Type.Object({ entries: Type.Array(Type.String()) });

const getStorePath = (cwd: string) =>
  path.join(
    getExtensionStoragePaths("stash").dataDir,
    `${createHash("sha256").update(path.resolve(cwd)).digest("hex")}.json`
  );

export const createStash = () => {
  let stack: string[] = [];
  let pendingSave = Promise.resolve();

  const save = async (ctx: ExtensionContext) => {
    const filePath = getStorePath(ctx.cwd);
    const content = `${JSON.stringify({ entries: stack }, null, 2)}\n`;

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

  return {
    dispose: async () => {
      await pendingSave;
    },
    pop,
    restore: async (event: InputEvent, ctx: ExtensionContext) => {
      if (
        event.source !== "interactive" ||
        ctx.mode !== "tui" ||
        stack.length === 0
      ) {
        return;
      }

      await pop(ctx);
    },
    start: async (ctx: ExtensionContext) => {
      try {
        const data: unknown = JSON.parse(
          await readFile(getStorePath(ctx.cwd), "utf-8")
        );

        stack = Value.Check(StashFileSchema, data)
          ? data.entries.slice(-MAX_STASHES)
          : [];
      } catch (error) {
        stack = [];

        if (error instanceof SyntaxError) {
          return;
        }

        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }

        ctx.ui.notify("Failed to load persisted stash.", "warning");
      }
    },
    toggle: async (ctx: ExtensionContext) => {
      const text = ctx.ui.getEditorText();

      if (!text.trim()) {
        await pop(ctx);

        return;
      }

      stack.push(text);

      if (stack.length > MAX_STASHES) {
        stack.shift();
      }

      ctx.ui.setEditorText("");
      ctx.ui.notify(`Stashed (${stack.length}).`, "info");
      await save(ctx);
    },
  };
};
