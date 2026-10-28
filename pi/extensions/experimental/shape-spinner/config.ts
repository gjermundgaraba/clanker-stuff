import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import {
  FRAME_INTERVAL_MS,
  manifest,
  RUBIK,
  wireframe,
} from "@clanker-stuff/pi-shape-glyphs";
import type { Ink, Wireframe } from "@clanker-stuff/pi-shape-glyphs";
import type { ThemeAppearance } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const shapes = [
  "rubik",
  ...Object.keys(manifest.animations).filter((key): key is Wireframe =>
    Object.hasOwn(manifest.animations, key)
  ),
] as const;

export const colors: readonly Ink[] = Object.keys(manifest.inks).filter(
  (key): key is Ink => Object.hasOwn(manifest.inks, key)
);

export const motions = ["animated", "static"] as const;

export const ConfigSchema = Type.Object(
  {
    color: Type.Enum(colors),
    motion: Type.Enum(motions),
    shape: Type.Enum(shapes),
  },
  { additionalProperties: false }
);

export type Config = Static<typeof ConfigSchema>;

export const defaultConfig = (): Config => ({
  color: "cyan",
  motion: "animated",
  shape: "orb",
});

export const styleFor = (config: Config, appearance: ThemeAppearance) => {
  const animation =
    config.shape === "rubik"
      ? RUBIK
      : wireframe(config.shape, config.color, appearance);

  return {
    frames:
      config.motion === "static" ? [animation.still] : [...animation.frames],
    intervalMs: FRAME_INTERVAL_MS,
  };
};

export const configPath = () =>
  getExtensionStoragePaths("shape-spinner").configFile;

export const loadConfig = async (): Promise<Config> => {
  try {
    const value: unknown = JSON.parse(await readFile(configPath(), "utf-8"));

    return Value.Check(ConfigSchema, value) ? value : defaultConfig();
  } catch {
    return defaultConfig();
  }
};

export const saveConfig = async (config: Config): Promise<void> => {
  const target = path.resolve(configPath());

  await withFileMutationQueue(target, async () => {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
  });
};
