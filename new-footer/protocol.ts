/* oxlint-disable eslint/complexity -- one validation pass preserves stable protocol error classes */

import { Type } from "typebox";
import { Value } from "typebox/value";

import { FOOTER_PROTOCOL_VERSION } from "./types.js";
import type {
  FooterContent,
  FooterSpan,
  FooterWidgetHealth,
  FooterWidgetIcon,
  FooterWidgetMessage,
  FooterWidgetSnapshot,
} from "./types.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; class: string; message: string };

const STRICT = { additionalProperties: false } as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/u;

const ToneSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("dim"),
  Type.Literal("muted"),
  Type.Literal("accent"),
  Type.Literal("success"),
  Type.Literal("warning"),
  Type.Literal("error"),
]);
const TruncationSchema = Type.Union([
  Type.Literal("start"),
  Type.Literal("middle"),
  Type.Literal("end"),
]);
const HealthStateSchema = Type.Union([
  Type.Literal("loading"),
  Type.Literal("ready"),
  Type.Literal("stale"),
  Type.Literal("error"),
]);
const SpanSchema = Type.Object(
  {
    bold: Type.Optional(Type.Boolean()),
    text: Type.String({ maxLength: 1024 }),
    tone: Type.Optional(ToneSchema),
  },
  STRICT
);
const ContentSchema = Type.Array(SpanSchema, { maxItems: 32 });
const IconGlyphMapSchema = Type.Object(
  {
    ascii: Type.Optional(Type.String({ maxLength: 16 })),
    nerd: Type.Optional(Type.String({ maxLength: 16 })),
    unicode: Type.Optional(Type.String({ maxLength: 16 })),
  },
  STRICT
);
const IconSchema = Type.Union([
  Type.Literal(false),
  Type.Object(
    {
      glyphs: Type.Union([Type.String({ maxLength: 16 }), IconGlyphMapSchema]),
      tone: Type.Optional(ToneSchema),
    },
    STRICT
  ),
]);
const DefaultsSchema = Type.Object(
  { enabled: Type.Optional(Type.Boolean()) },
  STRICT
);
const HealthSchema = Type.Object(
  {
    message: Type.Optional(Type.String({ maxLength: 512 })),
    state: HealthStateSchema,
    updatedAt: Type.Optional(Type.Number()),
  },
  STRICT
);
const ConsumedStatusKeysSchema = Type.Array(
  Type.String({ maxLength: 128, minLength: 1 }),
  { maxItems: 16 }
);
const SnapshotShapeSchema = Type.Object(
  {
    consumesStatusKeys: Type.Optional(Type.Unknown()),
    content: Type.Unknown(),
    defaults: Type.Optional(Type.Unknown()),
    health: Type.Optional(Type.Unknown()),
    icon: Type.Optional(Type.Unknown()),
    id: Type.Unknown(),
    label: Type.Unknown(),
    truncate: Type.Optional(Type.Unknown()),
  },
  STRICT
);
const InstanceIdSchema = Type.String({ maxLength: 128, minLength: 1 });
const RemoveMessageSchema = Type.Object(
  {
    id: Type.Unknown(),
    instanceId: InstanceIdSchema,
    protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
    type: Type.Literal("remove"),
  },
  STRICT
);
const UpsertMessageSchema = Type.Object(
  {
    instanceId: InstanceIdSchema,
    protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
    type: Type.Literal("upsert"),
    widget: Type.Unknown(),
  },
  STRICT
);
const RichWidgetIdSchema = Type.String({ maxLength: 128, minLength: 1 });

const codePointLength = (value: string): number => {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
  }
  return length;
};

const hasUnsafeRichText = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x1b ||
      code === 0x0a ||
      code === 0x0d ||
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
};

const validText = (
  value: unknown,
  maximum: number,
  allowEmpty = true
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  codePointLength(value) <= maximum &&
  !hasUnsafeRichText(value);

export const validateRichWidgetId = (value: unknown): value is string =>
  Value.Check(RichWidgetIdSchema, value) &&
  ID_PATTERN.test(value) &&
  !value.startsWith("footer.") &&
  !value.startsWith("status:");

const parseContent = (value: unknown): FooterContent | undefined => {
  if (!Value.Check(ContentSchema, value)) {
    return undefined;
  }
  const spans: FooterSpan[] = [];
  let length = 0;
  for (const candidate of value) {
    if (!validText(candidate.text, 1024)) {
      return undefined;
    }
    length += codePointLength(candidate.text);
    if (length > 1024) {
      return undefined;
    }
    spans.push({
      text: candidate.text,
      ...(candidate.tone === undefined ? {} : { tone: candidate.tone }),
      ...(candidate.bold === undefined ? {} : { bold: candidate.bold }),
    });
  }
  return spans;
};

const parseIcon = (value: unknown): FooterWidgetIcon | false | undefined => {
  if (!Value.Check(IconSchema, value)) {
    return undefined;
  }
  if (value === false) {
    return false;
  }
  if (typeof value.glyphs === "string") {
    if (!validText(value.glyphs, 16)) {
      return undefined;
    }
    return {
      glyphs: value.glyphs,
      ...(value.tone === undefined ? {} : { tone: value.tone }),
    };
  }
  if (
    Object.values(value.glyphs).some(
      (glyph) => glyph !== undefined && !validText(glyph, 16)
    )
  ) {
    return undefined;
  }
  return {
    glyphs: Object.fromEntries(
      Object.entries(value.glyphs).filter((entry) => entry[1] !== undefined)
    ),
    ...(value.tone === undefined ? {} : { tone: value.tone }),
  };
};

const parseHealth = (value: unknown): FooterWidgetHealth | undefined => {
  if (
    !Value.Check(HealthSchema, value) ||
    (value.message !== undefined && !validText(value.message, 512))
  ) {
    return undefined;
  }
  return {
    state: value.state,
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
};

export const validateFooterWidgetSnapshot = (
  value: unknown
): ValidationResult<FooterWidgetSnapshot> => {
  if (!Value.Check(SnapshotShapeSchema, value)) {
    return {
      class: "schema",
      message: "widget must be a strict object",
      ok: false,
    };
  }
  if (!validateRichWidgetId(value.id)) {
    return {
      class: "id",
      message: "widget id is invalid or reserved",
      ok: false,
    };
  }
  if (!validText(value.label, 80, false)) {
    return { class: "text", message: "widget label is invalid", ok: false };
  }
  const content = parseContent(value.content);
  if (!content) {
    return {
      class: "content",
      message: "widget content is invalid",
      ok: false,
    };
  }
  const icon = value.icon === undefined ? undefined : parseIcon(value.icon);
  if (value.icon !== undefined && icon === undefined) {
    return { class: "icon", message: "widget icon is invalid", ok: false };
  }
  if (
    value.defaults !== undefined &&
    !Value.Check(DefaultsSchema, value.defaults)
  ) {
    return {
      class: "defaults",
      message: "widget display defaults are invalid",
      ok: false,
    };
  }
  const health =
    value.health === undefined ? undefined : parseHealth(value.health);
  if (value.health !== undefined && health === undefined) {
    return { class: "health", message: "widget health is invalid", ok: false };
  }
  let consumesStatusKeys: string[] | undefined;
  if (value.consumesStatusKeys !== undefined) {
    if (
      !Value.Check(ConsumedStatusKeysSchema, value.consumesStatusKeys) ||
      !value.consumesStatusKeys.every((key) => validText(key, 128, false))
    ) {
      return {
        class: "fallback",
        message: "consumed status keys are invalid",
        ok: false,
      };
    }
    consumesStatusKeys = [...value.consumesStatusKeys];
  }
  if (
    value.truncate !== undefined &&
    !Value.Check(TruncationSchema, value.truncate)
  ) {
    return {
      class: "truncate",
      message: "widget truncation hint is invalid",
      ok: false,
    };
  }
  let defaults: FooterWidgetSnapshot["defaults"];
  if (value.defaults !== undefined) {
    defaults =
      value.defaults.enabled === undefined
        ? {}
        : { enabled: value.defaults.enabled };
  }
  return {
    ok: true,
    value: {
      content,
      id: value.id,
      label: value.label,
      ...(icon === undefined ? {} : { icon }),
      ...(defaults === undefined ? {} : { defaults }),
      ...(health === undefined ? {} : { health }),
      ...(consumesStatusKeys === undefined ? {} : { consumesStatusKeys }),
      ...(value.truncate === undefined ? {} : { truncate: value.truncate }),
    },
  };
};

export const validateFooterWidgetMessage = (
  value: unknown
): ValidationResult<FooterWidgetMessage> => {
  if (
    Value.Check(RemoveMessageSchema, value) &&
    validateRichWidgetId(value.id)
  ) {
    return {
      ok: true,
      value: {
        id: value.id,
        instanceId: value.instanceId,
        protocol: 1,
        type: "remove",
      },
    };
  }
  if (Value.Check(UpsertMessageSchema, value)) {
    const widget = validateFooterWidgetSnapshot(value.widget);
    if (!widget.ok) {
      return widget;
    }
    return {
      ok: true,
      value: {
        instanceId: value.instanceId,
        protocol: 1,
        type: "upsert",
        widget: widget.value,
      },
    };
  }
  return {
    class: "message",
    message: "widget message type is invalid",
    ok: false,
  };
};
