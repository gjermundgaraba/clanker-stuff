export const FOOTER_PROTOCOL_VERSION = 1 as const;
export const FOOTER_READY_EVENT = "clanker-footer:ready";
export const FOOTER_READY_REQUEST_EVENT = "clanker-footer:ready-request";
export const FOOTER_WIDGET_EVENT = "clanker-footer:widget";

export type FooterTone =
  | "text"
  | "dim"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error";

export interface FooterSpan {
  text: string;
  tone?: FooterTone;
  bold?: boolean;
}

export type FooterContent = readonly FooterSpan[];
export type FooterIconFamily = "ascii" | "unicode" | "nerd";
export type FooterTruncation = "start" | "middle" | "end";
export type FooterWidgetHealthState = "loading" | "ready" | "stale" | "error";

export interface FooterWidgetDisplayDefaults {
  enabled?: boolean;
}

export interface FooterWidgetHealth {
  state: FooterWidgetHealthState;
  message?: string;
  updatedAt?: number;
}

export interface FooterWidgetIcon {
  glyphs: string | Partial<Record<FooterIconFamily, string>>;
  tone?: FooterTone;
}

export interface FooterWidgetSnapshot {
  id: string;
  label: string;
  content: FooterContent;
  icon?: FooterWidgetIcon | false;
  defaults?: FooterWidgetDisplayDefaults;
  health?: FooterWidgetHealth;
  consumesStatusKeys?: readonly string[];
  truncate?: FooterTruncation;
}

export interface FooterReadyMessage {
  protocol: typeof FOOTER_PROTOCOL_VERSION;
  type: "ready";
  instanceId: string;
}

export interface FooterReadyRequestMessage {
  protocol: typeof FOOTER_PROTOCOL_VERSION;
  type: "ready-request";
}

export type FooterWidgetMessage =
  | {
      protocol: typeof FOOTER_PROTOCOL_VERSION;
      type: "upsert";
      instanceId: string;
      widget: FooterWidgetSnapshot;
    }
  | {
      protocol: typeof FOOTER_PROTOCOL_VERSION;
      type: "remove";
      instanceId: string;
      id: string;
    };

export const isFooterReadyMessage = (
  value: unknown
): value is FooterReadyMessage =>
  typeof value === "object" &&
  value !== null &&
  "protocol" in value &&
  value.protocol === FOOTER_PROTOCOL_VERSION &&
  "type" in value &&
  value.type === "ready" &&
  "instanceId" in value &&
  typeof value.instanceId === "string";

export const isFooterReadyRequestMessage = (
  value: unknown
): value is FooterReadyRequestMessage =>
  typeof value === "object" &&
  value !== null &&
  "protocol" in value &&
  value.protocol === FOOTER_PROTOCOL_VERSION &&
  "type" in value &&
  value.type === "ready-request";
