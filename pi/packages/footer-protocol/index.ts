import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export const FOOTER_PROTOCOL_VERSION = 1 as const;
export const FOOTER_READY_EVENT = "clanker-footer:ready";
export const FOOTER_READY_REQUEST_EVENT = "clanker-footer:ready-request";
export const FOOTER_WIDGET_EVENT = "clanker-footer:widget";

const STRICT = { additionalProperties: false } as const;

export const FooterToneSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("dim"),
  Type.Literal("muted"),
  Type.Literal("accent"),
  Type.Literal("success"),
  Type.Literal("warning"),
  Type.Literal("error"),
]);
export type FooterTone = Static<typeof FooterToneSchema>;

export const FooterSpanSchema = Type.Object(
  {
    bold: Type.Optional(Type.Boolean()),
    text: Type.String({ maxLength: 1024 }),
    tone: Type.Optional(FooterToneSchema),
  },
  STRICT,
);
export type FooterSpan = Static<typeof FooterSpanSchema>;

export const FooterContentSchema = Type.Array(FooterSpanSchema, { maxItems: 32 });
export type FooterContent = Static<typeof FooterContentSchema>;

export const FooterIconFamilySchema = Type.Union([
  Type.Literal("ascii"),
  Type.Literal("unicode"),
  Type.Literal("nerd"),
]);
export type FooterIconFamily = Static<typeof FooterIconFamilySchema>;

export const FooterTruncationSchema = Type.Union([
  Type.Literal("start"),
  Type.Literal("middle"),
  Type.Literal("end"),
]);
export type FooterTruncation = Static<typeof FooterTruncationSchema>;

export const FooterWidgetHealthStateSchema = Type.Union([
  Type.Literal("loading"),
  Type.Literal("ready"),
  Type.Literal("stale"),
  Type.Literal("error"),
]);
export type FooterWidgetHealthState = Static<typeof FooterWidgetHealthStateSchema>;

export const FooterWidgetDisplayDefaultsSchema = Type.Object(
  { enabled: Type.Optional(Type.Boolean()) },
  STRICT,
);
export type FooterWidgetDisplayDefaults = Static<typeof FooterWidgetDisplayDefaultsSchema>;

export const FooterWidgetHealthSchema = Type.Object(
  {
    message: Type.Optional(Type.String({ maxLength: 512 })),
    state: FooterWidgetHealthStateSchema,
    updatedAt: Type.Optional(Type.Number()),
  },
  STRICT,
);
export type FooterWidgetHealth = Static<typeof FooterWidgetHealthSchema>;

export const FooterWidgetGlyphMapSchema = Type.Object(
  {
    ascii: Type.Optional(Type.String({ maxLength: 16 })),
    nerd: Type.Optional(Type.String({ maxLength: 16 })),
    unicode: Type.Optional(Type.String({ maxLength: 16 })),
  },
  STRICT,
);
export type FooterWidgetGlyphMap = Static<typeof FooterWidgetGlyphMapSchema>;

export const FooterWidgetIconSchema = Type.Object(
  {
    glyphs: Type.Union([Type.String({ maxLength: 16 }), FooterWidgetGlyphMapSchema]),
    tone: Type.Optional(FooterToneSchema),
  },
  STRICT,
);
export type FooterWidgetIcon = Static<typeof FooterWidgetIconSchema>;

export const FooterWidgetSnapshotSchema = Type.Object(
  {
    consumesStatusKeys: Type.Optional(
      Type.Array(Type.String({ maxLength: 128, minLength: 1 }), { maxItems: 16 }),
    ),
    content: FooterContentSchema,
    defaults: Type.Optional(FooterWidgetDisplayDefaultsSchema),
    health: Type.Optional(FooterWidgetHealthSchema),
    icon: Type.Optional(Type.Union([FooterWidgetIconSchema, Type.Literal(false)])),
    id: Type.String({ maxLength: 128, minLength: 1 }),
    label: Type.String({ maxLength: 80, minLength: 1 }),
    truncate: Type.Optional(FooterTruncationSchema),
  },
  STRICT,
);
export type FooterWidgetSnapshot = Static<typeof FooterWidgetSnapshotSchema>;

export const FooterReadyMessageSchema = Type.Object(
  {
    instanceId: Type.String({ maxLength: 128, minLength: 1 }),
    protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
    type: Type.Literal("ready"),
  },
  STRICT,
);
export type FooterReadyMessage = Static<typeof FooterReadyMessageSchema>;

export const FooterReadyRequestMessageSchema = Type.Object(
  {
    protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
    type: Type.Literal("ready-request"),
  },
  STRICT,
);
export type FooterReadyRequestMessage = Static<typeof FooterReadyRequestMessageSchema>;

export const FooterWidgetMessageSchema = Type.Union([
  Type.Object(
    {
      instanceId: Type.String({ maxLength: 128, minLength: 1 }),
      protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
      type: Type.Literal("upsert"),
      widget: FooterWidgetSnapshotSchema,
    },
    STRICT,
  ),
  Type.Object(
    {
      id: Type.String({ maxLength: 128, minLength: 1 }),
      instanceId: Type.String({ maxLength: 128, minLength: 1 }),
      protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
      type: Type.Literal("remove"),
    },
    STRICT,
  ),
]);
export type FooterWidgetMessage = Static<typeof FooterWidgetMessageSchema>;

const FooterProtocolInputSchema = Type.Unknown();
export type FooterProtocolInput = Static<typeof FooterProtocolInputSchema>;

const parse = <Schema extends TSchema>(
  schema: Schema,
  value: FooterProtocolInput,
): Static<Schema> | undefined => {
  return Value.Check(schema, value) ? value : undefined;
};

export const parseFooterReadyMessage = (
  value: FooterProtocolInput,
): FooterReadyMessage | undefined => parse(FooterReadyMessageSchema, value);

export const parseFooterReadyRequestMessage = (
  value: FooterProtocolInput,
): FooterReadyRequestMessage | undefined => parse(FooterReadyRequestMessageSchema, value);

export const parseFooterWidgetMessage = (
  value: FooterProtocolInput,
): FooterWidgetMessage | undefined => parse(FooterWidgetMessageSchema, value);

export const parseFooterWidgetSnapshot = (
  value: FooterProtocolInput,
): FooterWidgetSnapshot | undefined => parse(FooterWidgetSnapshotSchema, value);

export const isFooterReadyMessage = (value: FooterProtocolInput): value is FooterReadyMessage =>
  parseFooterReadyMessage(value) !== undefined;

export const isFooterReadyRequestMessage = (
  value: FooterProtocolInput,
): value is FooterReadyRequestMessage => parseFooterReadyRequestMessage(value) !== undefined;
