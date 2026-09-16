import { IconFamilySchema } from "@clanker-stuff/status-icons";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;
const WidgetOverrideSchema = Type.Object({ enabled: Type.Optional(Type.Boolean()) }, STRICT);
const WidgetIdSchema = Type.String({ maxLength: 256, minLength: 1 });
const RowSchema = Type.Object(
  {
    center: Type.Array(WidgetIdSchema),
    left: Type.Array(WidgetIdSchema),
    right: Type.Array(WidgetIdSchema),
  },
  STRICT,
);
const FooterConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    iconFamily: IconFamilySchema,
    rows: Type.Array(RowSchema, { maxItems: 3, minItems: 1 }),
    separator: Type.String({ maxLength: 8 }),
    version: Type.Literal(1),
    widgets: Type.Record(Type.String(), WidgetOverrideSchema),
  },
  STRICT,
);

export type FooterConfig = Static<typeof FooterConfigSchema>;

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

export const hasTerminalControl = (value: string): boolean => /\p{Cc}/u.test(value);

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
      return [id, override.enabled === undefined ? {} : { enabled: override.enabled }];
    }),
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

export const cloneFooterConfig = (config: FooterConfig): FooterConfig => structuredClone(config);
