import { readFile } from "node:fs/promises";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;

const Id = Type.String({ minLength: 1 });

const RecapConfigSchema = Type.Object(
  {
    model: Type.Object({ id: Id, provider: Id }, STRICT),
    thinking: Type.Optional(
      StringEnum([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] as const)
    ),
  },
  STRICT
);

export type RecapConfig = Required<Static<typeof RecapConfigSchema>>;

export const getRecapConfigPath = (): string =>
  getExtensionStoragePaths("turn-recap").configFile;

export const parseRecapConfig = (value: unknown): RecapConfig => {
  if (!Value.Check(RecapConfigSchema, value)) {
    throw new Error(
      `Invalid turn-recap configuration: ${Value.Errors(
        RecapConfigSchema,
        value
      )
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ")}`
    );
  }

  return { model: value.model, thinking: value.thinking ?? "off" };
};

export const loadRecapConfig = async (
  configPath = getRecapConfigPath()
): Promise<RecapConfig | undefined> => {
  let text: string;

  try {
    text = await readFile(configPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  return parseRecapConfig(JSON.parse(text));
};
