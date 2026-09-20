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

export const backgrounds = ["dark", "light"] as const;

export const motions = ["animated", "static"] as const;

/** Pi's working indicator plus the shared editor's border status kinds. */
export const kinds = ["working", "retry", "compaction", "branchSummary"] as const;

export type Kind = (typeof kinds)[number];

const LookSchema = Type.Object(
  { color: Type.Enum(colors), enabled: Type.Boolean(), shape: Type.Enum(shapes) },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    background: Type.Enum(backgrounds),
    looks: Type.Object(
      {
        branchSummary: LookSchema,
        compaction: LookSchema,
        retry: LookSchema,
        working: LookSchema,
      },
      { additionalProperties: false },
    ),
    motion: Type.Enum(motions),
    version: Type.Literal(1),
  },
  { additionalProperties: false },
);

export type Config = Static<typeof ConfigSchema>;

// Shape signals the kind of work; color follows its severity.
export const defaultConfig = (): Config => ({
  background: "dark",
  looks: {
    branchSummary: { color: "blue", enabled: true, shape: "octahedron" },
    compaction: { color: "purple", enabled: true, shape: "cube" },
    retry: { color: "orange", enabled: true, shape: "tetrahedron" },
    working: { color: "cyan", enabled: true, shape: "orb" },
  },
  motion: "animated",
  version: 1,
});

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
