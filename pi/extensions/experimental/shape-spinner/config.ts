import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const shapes = ["rubik", "orb", "cube", "octahedron", "tetrahedron"] as const;

export const colors = [
  "blue",
  "purple",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "gray",
] as const;

export const motions = ["animated", "static"] as const;

export const ConfigSchema = Type.Object(
  { color: Type.Enum(colors), motion: Type.Enum(motions), shape: Type.Enum(shapes) },
  { additionalProperties: false },
);

export type Config = Static<typeof ConfigSchema>;

export const defaultConfig = (): Config => ({ color: "cyan", motion: "animated", shape: "orb" });

export const configPath = () => getExtensionStoragePaths("shape-spinner").configFile;

export async function loadConfig(file = configPath()): Promise<Config> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));

    return Value.Check(ConfigSchema, value) ? value : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(config: Config, file = configPath()): Promise<void> {
  const target = path.resolve(file);

  await withFileMutationQueue(target, async () => {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
  });
}
