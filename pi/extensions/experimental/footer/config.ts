import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  cloneFooterConfig,
  parseFooterConfig,
} from "@clanker-stuff/footer-protocol/config";
import type { FooterConfig } from "@clanker-stuff/footer-protocol/config";
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface LoadedFooterConfig {
  config: FooterConfig;
  error?: string;
}

export interface FooterConfigStore {
  path: string;
  load: () => Promise<LoadedFooterConfig>;
  save: (config: FooterConfig) => Promise<void>;
}

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Object && "code" in cause ? String(cause.code) : undefined;

export const getFooterConfigPath = (): string => getExtensionStoragePaths("footer").configFile;

export const createFooterConfigStore = (configPath = getFooterConfigPath()): FooterConfigStore => {
  const targetPath = path.resolve(configPath);

  return {
    async load() {
      let text: string;

      try {
        text = await readFile(targetPath, "utf-8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return {
            config: cloneFooterConfig(DEFAULT_CONFIG),
          };
        }

        return {
          config: cloneFooterConfig(DEFAULT_CONFIG),
          error: `Failed to read ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      try {
        return {
          config: parseFooterConfig(JSON.parse(text)),
        };
      } catch (error) {
        return {
          config: cloneFooterConfig(DEFAULT_CONFIG),
          error: `Invalid ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    path: targetPath,
    async save(config) {
      const validated = parseFooterConfig(config);
      await withFileMutationQueue(targetPath, async () => {
        // Replace the symlink's target, not the link, so a dotfiles-managed config stays linked.
        const writePath = await realpath(targetPath).catch(async (error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;

          const entry = await lstat(targetPath).catch((cause: unknown) => {
            if (errorCode(cause) === "ENOENT") return undefined;
            throw cause;
          });

          if (entry?.isSymbolicLink()) {
            throw new Error(`Cannot save footer config through dangling symlink: ${targetPath}`);
          }

          return targetPath;
        });

        await mkdir(path.dirname(writePath), { recursive: true });
        const temporary = `${writePath}.tmp-${process.pid}-${randomUUID()}`;

        try {
          await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
          });
          await rename(temporary, writePath);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
};
