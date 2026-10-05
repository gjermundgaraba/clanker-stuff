import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const IdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\p{Cc}]*$" }),
);

const FooterConfigSchema = Type.Object(
  {
    iconFamily: Type.Union([Type.Literal("ascii"), Type.Literal("unicode"), Type.Literal("nerd")]),
    rows: Type.Array(
      Type.Object({ left: IdsSchema, right: IdsSchema }, { additionalProperties: false }),
    ),
    border: IdsSchema,
    hidden: IdsSchema,
  },
  { additionalProperties: false },
);

export type FooterConfig = Static<typeof FooterConfigSchema>;

export type IconFamily = FooterConfig["iconFamily"];

export const STATUSES_ID = "footer.statuses";

export const STATUS_PREFIX = "status:";

export const DEFAULT_CONFIG: FooterConfig = {
  iconFamily: "unicode",
  rows: [
    { left: ["footer.cwd", "footer.git"], right: ["footer.model", "footer.thinking"] },
    { left: ["footer.context"], right: ["status:usage"] },
    { left: [STATUSES_ID], right: [] },
  ],
  border: [
    "status:ask-question",
    "status:vim",
    "status:background-tasks.pending",
    "status:background-tasks.active",
  ],
  hidden: [],
};

/** Every placement in render order: rows left to right, then the editor border. */
export const placedIds = (config: FooterConfig): string[] => [
  ...config.rows.flatMap((row) => [...row.left, ...row.right]),
  ...config.border,
];

export const parseFooterConfig = (text: string): FooterConfig => {
  const value: unknown = JSON.parse(text);

  if (!Value.Check(FooterConfigSchema, value)) {
    const error = Value.Errors(FooterConfigSchema, value).find(
      ({ keyword }) => keyword !== "boolean",
    );

    throw new Error(`${error?.instancePath || "/"} ${error?.message ?? "is invalid"}`);
  }

  const seen = new Set<string>();

  for (const id of [...placedIds(value), ...value.hidden]) {
    if (seen.has(id)) throw new Error(`widget ${id} is listed twice`);
    seen.add(id);
  }

  // Only native statuses reach `footer.statuses`, so only they can be hidden from it.
  const notStatus = value.hidden.find((id) => !id.startsWith(STATUS_PREFIX));

  if (notStatus !== undefined)
    throw new Error(`hidden accepts only status:<key> IDs, not ${notStatus}`);

  // The border falls back to `footer.statuses` while another editor is installed.
  if (value.border.includes(STATUSES_ID))
    throw new Error(`${STATUSES_ID} can only be placed in a row`);

  return value;
};

export const formatFooterConfig = (config: FooterConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

export interface LoadedFooterConfig {
  config: FooterConfig;
  /** The file's text, when it exists, so the editor reopens what the user wrote. */
  text?: string;
  error?: string;
}

export interface FooterConfigStore {
  path: string;
  load: () => Promise<LoadedFooterConfig>;
  save: (config: FooterConfig) => Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createFooterConfigStore = (
  configPath = getExtensionStoragePaths("footer").configFile,
): FooterConfigStore => {
  const target = path.resolve(configPath);

  return {
    path: target,
    async load() {
      let text: string;

      try {
        text = await readFile(target, "utf-8");
      } catch (error) {
        return error instanceof Error && "code" in error && error.code === "ENOENT"
          ? { config: DEFAULT_CONFIG }
          : { config: DEFAULT_CONFIG, error: `Cannot read ${target}: ${message(error)}` };
      }

      try {
        return { config: parseFooterConfig(text), text };
      } catch (error) {
        return { config: DEFAULT_CONFIG, error: `Invalid ${target}: ${message(error)}`, text };
      }
    },
    async save(config) {
      // A plain write follows a dotfiles symlink to its target instead of replacing the link.
      await withFileMutationQueue(target, async () => {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, formatFooterConfig(config), "utf-8");
      });
    },
  };
};
