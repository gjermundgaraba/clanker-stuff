import { DEFAULT_CONFIG, parseFooterConfig } from "@clanker-stuff/footer-protocol/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { IconFamilySchema } from "@clanker-stuff/status-icons";
import type { IconFamily } from "@clanker-stuff/status-icons";
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const ConfigSchema = Type.Object(
  { version: Type.Literal(1), iconFamily: Type.Union([Type.Literal("inherit"), IconFamilySchema]) },
  { additionalProperties: false },
);
export type Config = Static<typeof ConfigSchema>;
export const defaultConfig: Config = { version: 1, iconFamily: "inherit" };
export const configPath = () => getExtensionStoragePaths("border-status").configFile;

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};
export async function loadConfig(file = configPath()): Promise<Config> {
  const value = await readJson(file);
  return Value.Check(ConfigSchema, value) ? value : { ...defaultConfig };
}
export async function loadFooterPreference(
  file = getExtensionStoragePaths("footer").configFile,
): Promise<IconFamily> {
  const value = await readJson(file);
  try {
    return parseFooterConfig(value).iconFamily;
  } catch {
    return DEFAULT_CONFIG.iconFamily;
  }
}
export async function saveConfig(config: Config, file = configPath()): Promise<void> {
  if (!Value.Check(ConfigSchema, config)) throw new Error("Invalid border-status config");
  const target = path.resolve(file);
  await withFileMutationQueue(target, async () => {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  });
}
