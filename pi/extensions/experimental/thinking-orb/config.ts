/**
 * Extension configuration stored at `~/.pi/agent/thinking-orb.json`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface OrbConfig {
  autoStart: boolean;
  backingScale?: number;
  enabled: boolean;
  fps: number;
  version: 1;
}

const STRICT = { additionalProperties: false } as const;

const OrbConfigSchema = Type.Object(
  {
    autoStart: Type.Boolean(),
    backingScale: Type.Optional(
      Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])
    ),
    enabled: Type.Boolean(),
    fps: Type.Integer({ maximum: 60, minimum: 15 }),
    version: Type.Literal(1),
  },
  STRICT
);

export const DEFAULT_CONFIG: OrbConfig = {
  autoStart: true,
  enabled: true,
  fps: 60,
  version: 1,
};

export const cloneOrbConfig = (config: OrbConfig): OrbConfig =>
  structuredClone(config);

export interface LoadedOrbConfig {
  config: OrbConfig;
  error?: string;
}

export interface OrbConfigStore {
  load: () => Promise<LoadedOrbConfig>;
  path: string;
  save: (config: OrbConfig) => Promise<void>;
}

export const parseOrbConfig = (value: unknown): OrbConfig => {
  if (!Value.Check(OrbConfigSchema, value)) {
    throw new Error(
      "config must be an object with enabled, autoStart, fps (15-60), and optional backingScale (1-3)"
    );
  }
  return {
    autoStart: value.autoStart,
    backingScale: value.backingScale,
    enabled: value.enabled,
    fps: value.fps,
    version: 1,
  };
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

export const getOrbConfigPath = (): string =>
  getExtensionStoragePaths("thinking-orb").configFile;

export const createOrbConfigStore = (
  configPath = getOrbConfigPath()
): OrbConfigStore => {
  const targetPath = path.resolve(configPath);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(targetPath, "utf-8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return { config: cloneOrbConfig(DEFAULT_CONFIG) };
        }
        return {
          config: cloneOrbConfig(DEFAULT_CONFIG),
          error: `Failed to read ${targetPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      try {
        return { config: parseOrbConfig(JSON.parse(text)) };
      } catch (error) {
        return {
          config: cloneOrbConfig(DEFAULT_CONFIG),
          error: `Invalid ${targetPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    path: targetPath,
    async save(config) {
      const validated = parseOrbConfig(config);
      await withFileMutationQueue(targetPath, async () => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        const temporary = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await writeFile(
            temporary,
            `${JSON.stringify(validated, null, 2)}\n`,
            {
              encoding: "utf-8",
              mode: 0o600,
            }
          );
          await rename(temporary, targetPath);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
};
