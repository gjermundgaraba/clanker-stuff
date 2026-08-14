import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FooterIconFamily } from "@clanker-stuff/footer-protocol";
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface FooterRowConfig {
  left: string[];
  center: string[];
  right: string[];
}

export interface FooterWidgetOverride {
  enabled?: boolean;
}

export interface FooterConfig {
  version: 1;
  enabled: boolean;
  iconFamily: FooterIconFamily;
  separator: string;
  rows: FooterRowConfig[];
  widgets: Record<string, FooterWidgetOverride>;
}

const STRICT = { additionalProperties: false } as const;
const WidgetOverrideSchema = Type.Object(
  { enabled: Type.Optional(Type.Boolean()) },
  STRICT
);
const WidgetIdSchema = Type.String({ maxLength: 256, minLength: 1 });
const RowSchema = Type.Object(
  {
    center: Type.Array(WidgetIdSchema),
    left: Type.Array(WidgetIdSchema),
    right: Type.Array(WidgetIdSchema),
  },
  STRICT
);
const FooterConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    iconFamily: Type.Union([
      Type.Literal("ascii"),
      Type.Literal("unicode"),
      Type.Literal("nerd"),
    ]),
    rows: Type.Array(RowSchema, { maxItems: 3, minItems: 1 }),
    separator: Type.String({ maxLength: 8 }),
    version: Type.Literal(1),
    widgets: Type.Record(Type.String(), WidgetOverrideSchema),
  },
  STRICT
);

export const DEFAULT_CONFIG: FooterConfig = {
  enabled: true,
  iconFamily: "unicode",
  rows: [
    {
      center: [],
      left: ["footer.cwd", "footer.git"],
      right: ["footer.model", "footer.thinking"],
    },
    {
      center: [],
      left: ["footer.context"],
      right: ["clanker.usage.active"],
    },
    {
      center: [],
      left: ["footer.widgets", "footer.statuses"],
      right: [],
    },
  ],
  separator: "·",
  version: 1,
  widgets: {},
};

export interface LoadedFooterConfig {
  config: FooterConfig;
  error?: string;
}

export interface FooterConfigStore {
  path: string;
  load: () => Promise<LoadedFooterConfig>;
  save: (config: FooterConfig) => Promise<void>;
}

export const hasTerminalControl = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x0a ||
      code === 0x0d ||
      code === 0x1b ||
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
};

const codePointLength = (value: string): number => {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
  }
  return length;
};

const validateId = (id: string): void => {
  if (hasTerminalControl(id)) {
    throw new Error("widget ID contains terminal controls");
  }
};

export const parseFooterConfig = (value: unknown): FooterConfig => {
  if (!Value.Check(FooterConfigSchema, value)) {
    throw new Error("config must be a strict object");
  }
  if (hasTerminalControl(value.separator)) {
    throw new Error("separator must be at most 8 printable code points");
  }
  for (const row of value.rows) {
    for (const id of [...row.left, ...row.center, ...row.right]) {
      validateId(id);
    }
  }
  const widgets = Object.fromEntries(
    Object.entries(value.widgets).map(([id, override]) => {
      if (id.length === 0 || codePointLength(id) > 256) {
        throw new Error("widget override ID is invalid");
      }
      validateId(id);
      return [
        id,
        override.enabled === undefined ? {} : { enabled: override.enabled },
      ];
    })
  );
  return {
    enabled: value.enabled,
    iconFamily: value.iconFamily,
    rows: value.rows.map((row) => ({
      center: [...row.center],
      left: [...row.left],
      right: [...row.right],
    })),
    separator: value.separator,
    version: 1,
    widgets,
  };
};

export const cloneFooterConfig = (config: FooterConfig): FooterConfig =>
  structuredClone(config);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

export const getFooterConfigPath = (): string =>
  getExtensionStoragePaths("footer").configFile;

export const createFooterConfigStore = (
  configPath = getFooterConfigPath()
): FooterConfigStore => {
  const targetPath = path.resolve(configPath);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(targetPath, "utf-8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return {
            config: cloneFooterConfig(DEFAULT_CONFIG),
          };
        }
        return {
          config: cloneFooterConfig(DEFAULT_CONFIG),
          error: `Failed to read ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      try {
        return {
          config: parseFooterConfig(JSON.parse(text)),
        };
      } catch (error) {
        return {
          config: cloneFooterConfig(DEFAULT_CONFIG),
          error: `Invalid ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    path: targetPath,
    async save(config) {
      const validated = parseFooterConfig(config);
      await withFileMutationQueue(targetPath, async () => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        const temporary = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await writeFile(
            temporary,
            `${JSON.stringify(validated, null, 2)}\n`,
            {
              encoding: "utf-8",
              mode: 0o600,
            }
          );
          await rename(temporary, targetPath);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
};
