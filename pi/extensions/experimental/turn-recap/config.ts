import { readFile } from "node:fs/promises";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;

// Pi matches ids exactly; a mistyped one fails its lookup with a visible recap error.
const Id = Type.String({ minLength: 1 });

/** The file exists only to configure recaps, so a model is required. */
const RecapConfigSchema = Type.Object(
  {
    model: Type.Object({ id: Id, provider: Id }, STRICT),
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
      `Invalid turn-recap configuration: ${Value.Errors(RecapConfigSchema, value)
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ")}`,
    );
  }

  return { model: value.model, thinking: value.thinking ?? "off" };
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
