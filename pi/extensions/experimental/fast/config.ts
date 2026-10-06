import { readFile } from "node:fs/promises";

import { Type } from "typebox";
import { Value } from "typebox/value";

const ConfigSchema = Type.Object({ fast: Type.Boolean() }, { additionalProperties: true });

export const loadFastDefault = async (configPath: string): Promise<boolean> => {
  try {
    const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));

    if (!Value.Check(ConfigSchema, raw)) throw new Error('Expected an object with "fast": boolean');

    return raw.fast;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;

    throw error;
  }
};
