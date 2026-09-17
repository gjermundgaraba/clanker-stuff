import { ToneSchema } from "@clanker-stuff/pi-tones";
import { IconFamilySchema, GlyphMapSchema } from "@clanker-stuff/status-icons";
import { Type } from "typebox";
import type { Static } from "typebox";

export const FOOTER_PROTOCOL_VERSION = 1 as const;
export const FOOTER_READY_EVENT = "clanker-footer:ready";
export const FOOTER_READY_REQUEST_EVENT = "clanker-footer:ready-request";
export const FOOTER_WIDGET_EVENT = "clanker-footer:widget";

const STRICT = { additionalProperties: false } as const;

export const FooterSpanSchema = Type.Object(
  {
    bold: Type.Optional(Type.Boolean()),
    text: Type.String({ maxLength: 1024 }),
    tone: Type.Optional(ToneSchema),
  },
  STRICT,
);
export type FooterSpan = Static<typeof FooterSpanSchema>;

export const FooterContentSchema = Type.Array(FooterSpanSchema, { maxItems: 32 });
export type FooterContent = Static<typeof FooterContentSchema>;

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

export const FooterWidgetIconSchema = Type.Object(
  {
    glyphs: Type.Union([Type.String({ maxLength: 16 }), GlyphMapSchema]),
    tone: Type.Optional(ToneSchema),
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

/** Committed icon preference, independent of whether the footer itself is enabled. */
export const FOOTER_ICON_PREFERENCE_EVENT = "clanker-footer:icon-preference";
export const FOOTER_ICON_PREFERENCE_REQUEST_EVENT = "clanker-footer:icon-preference-request";
export const FooterIconPreferenceSchema = Type.Object(
  {
    protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
    type: Type.Literal("icon-preference"),
    iconFamily: IconFamilySchema,
  },
  STRICT,
);

export const FooterIconPreferenceRequestSchema = Type.Object(
  {
    protocol: Type.Literal(FOOTER_PROTOCOL_VERSION),
    type: Type.Literal("icon-preference-request"),
  },
  STRICT,
);
