import { readFile } from "node:fs/promises";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;
const ConfigInputSchema = Type.Unknown();
type ConfigInput = Static<typeof ConfigInputSchema>;
const RecapConfigSchema = Type.Object(
  {
    model: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        provider: Type.String({ minLength: 1 }),
      },
      STRICT,
    ),
  },
  STRICT,
);

export type RecapConfig = Static<typeof RecapConfigSchema>;

export const getRecapConfigPath = (): string => getExtensionStoragePaths("recap").configFile;

export const parseRecapConfig = (value: ConfigInput): RecapConfig => {
  if (!Value.Check(RecapConfigSchema, value)) {
    throw new Error("config must contain only model.provider and model.id");
  }

  const provider = value.model.provider.trim();
  const id = value.model.id.trim();
  if (provider.length === 0 || id.length === 0) {
    throw new Error("model.provider and model.id must be non-empty");
  }

  return { model: { id, provider } };
};

export const loadRecapConfig = async (configPath = getRecapConfigPath()): Promise<RecapConfig> => {
  return parseRecapConfig(JSON.parse(await readFile(configPath, "utf-8")));
};
