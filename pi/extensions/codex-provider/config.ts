import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const parseConfig = (value: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { fast?: unknown }).fast !== "boolean"
  ) {
    throw new Error('config must be exactly { "fast": boolean }');
  }
  return (value as { fast: boolean }).fast;
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
      return parseConfig(JSON.parse(text));
    },
    path: targetPath,
    async save(enabled: boolean) {
      await withFileMutationQueue(targetPath, async () => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        const temporary = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await writeFile(
            temporary,
            `${JSON.stringify({ fast: enabled }, null, 2)}\n`,
            { encoding: "utf-8", mode: 0o600 }
          );
          await rename(temporary, targetPath);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
};
