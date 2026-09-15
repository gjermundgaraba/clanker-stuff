import { readFile } from "node:fs/promises";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;
const RecapConfigSchema = Type.Object(
  {
    model: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        provider: Type.String({ minLength: 1 }),
      },
      STRICT,
    ),
    thinking: Type.Optional(
      StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
    ),
  },
  STRICT,
);

export type RecapConfig = Static<typeof RecapConfigSchema>;

export const getRecapConfigPath = (): string => getExtensionStoragePaths("recap").configFile;

export const parseRecapConfig = (value: unknown): RecapConfig => {
  if (!Value.Check(RecapConfigSchema, value)) {
    throw new Error(
      "config must contain only model.provider, model.id, and optional thinking (off, minimal, low, medium, high, xhigh, max)",
    );
  }

  const provider = value.model.provider.trim();
  const id = value.model.id.trim();
  if (provider.length === 0 || id.length === 0) {
    throw new Error("model.provider and model.id must be non-empty");
  }

  const config: RecapConfig = { model: { id, provider } };
  if (value.thinking !== undefined) {
    config.thinking = value.thinking;
  }
  return config;
};

export const loadRecapConfig = async (configPath = getRecapConfigPath()): Promise<RecapConfig> => {
  return parseRecapConfig(JSON.parse(await readFile(configPath, "utf-8")));
};
