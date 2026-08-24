import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { FAST_MODE_STATUS_KEY } from "./footer.js";

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Object && "code" in cause ? String(cause.code) : undefined;

const FastConfigSchema = Type.Object({ fast: Type.Boolean() }, { additionalProperties: false });

const parseConfig = (text: string): boolean => {
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(FastConfigSchema, parsed)) {
    throw new Error('config must be exactly { "fast": boolean }');
  }
  return Value.Parse(FastConfigSchema, parsed).fast;
};

const runAfter = async (previous: Promise<void>, task: () => Promise<void>): Promise<void> => {
  try {
    await previous;
  } catch {
    // A failed operation must not block later commands.
  }
  await task();
};

export const createFastModeConfigStore = (configPath: string) => {
  const targetPath = path.resolve(configPath);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(targetPath, "utf-8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return false;
        }
        throw error;
      }
      return parseConfig(text);
    },
    path: targetPath,
    async save(enabled: boolean) {
      await withFileMutationQueue(targetPath, async () => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        const temporary = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await writeFile(temporary, `${JSON.stringify({ fast: enabled }, null, 2)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
          });
          await rename(temporary, targetPath);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
};

export const createFastModeState = (
  pi: ExtensionAPI,
  config: ReturnType<typeof createFastModeConfigStore>,
  setFooterActive: (active: boolean) => void = () => null,
) => {
  let enabled = false;
  let operation = Promise.resolve();
  let stopped = false;

  const enqueue = (task: () => Promise<void>): Promise<void> =>
    (operation = runAfter(operation, task));

  const refresh = (
    ctx: ExtensionContext,
    supportsFastMode: (model: Model<string> | undefined) => boolean,
  ): void => {
    const active = enabled && supportsFastMode(ctx.model);
    ctx.ui.setStatus(FAST_MODE_STATUS_KEY, active ? "⚡" : undefined);
    setFooterActive(active);
  };

  return {
    isEnabled: (): boolean => enabled,
    refresh,
    start: (ctx: ExtensionContext, useStartupFlag: boolean): Promise<void> =>
      enqueue(async () => {
        if (stopped) {
          return;
        }
        let next = false;
        if (useStartupFlag && pi.getFlag("fast") === true) {
          next = true;
        } else {
          try {
            next = await config.load();
          } catch (error) {
            if (!stopped) {
              ctx.ui.notify(
                `Failed to load ${config.path}; Codex fast mode is disabled: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            }
          }
        }
        if (!stopped) {
          enabled = next;
        }
      }),
    stop: (): void => {
      stopped = true;
    },
    toggle: (ctx: ExtensionContext): Promise<void> =>
      enqueue(async () => {
        if (stopped) {
          return;
        }
        const next = !enabled;
        try {
          await config.save(next);
        } catch (error) {
          if (!stopped) {
            ctx.ui.notify(
              `Failed to save ${config.path}; Codex fast mode was not changed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          return;
        }
        if (stopped) {
          return;
        }
        enabled = next;
        ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}`);
      }),
  };
};
