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

type RecapConfigFile = Static<typeof RecapConfigSchema>;

export interface RecapConfig {
  model: RecapConfigFile["model"];
  /** Requested thinking level; an omitted file value means `off`. */
  thinking: NonNullable<RecapConfigFile["thinking"]>;
}

export const getRecapConfigPath = (): string => getExtensionStoragePaths("turn-recap").configFile;

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

  return { model: { id, provider }, thinking: value.thinking ?? "off" };
};

export const loadRecapConfig = async (
  configPath = getRecapConfigPath(),
): Promise<RecapConfig | undefined> => {
  let text: string;

  try {
    text = await readFile(configPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }

  const value: unknown = JSON.parse(text);

  return parseRecapConfig(value);
};
