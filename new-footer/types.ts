import type { Theme } from "@earendil-works/pi-coding-agent";

export const FOOTER_PROTOCOL_VERSION = 1 as const;
export const FOOTER_READY_EVENT = "clanker-footer:ready";
export const FOOTER_WIDGET_EVENT = "clanker-footer:widget";
export const MAX_RICH_WIDGETS = 256;
export const MAX_PROTOCOL_ERRORS = 50;

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

export interface FooterWidgetIcon {
  glyphs: string | Partial<Record<FooterIconFamily, string>>;
  tone?: FooterTone;
}

export interface FooterWidgetDisplayDefaults {
  enabled?: boolean;
}

export type FooterTruncation = "start" | "middle" | "end";

export type FooterWidgetHealthState = "loading" | "ready" | "stale" | "error";

export interface FooterWidgetHealth {
  state: FooterWidgetHealthState;
  message?: string;
  updatedAt?: number;
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
  protocol: 1;
  type: "ready";
  instanceId: string;
}

export type FooterWidgetMessage =
  | {
      protocol: 1;
      type: "upsert";
      instanceId: string;
      widget: FooterWidgetSnapshot;
    }
  | {
      protocol: 1;
      type: "remove";
      instanceId: string;
      id: string;
    };

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

export type FooterSource = "builtin" | "native" | "rich";

export interface LiveWidget {
  snapshot: FooterWidgetSnapshot;
  source: FooterSource;
  nativeAnsi?: boolean;
}

export interface RenderableWidget {
  id: string;
  group: "left" | "center" | "right";
  text: string;
  truncate?: FooterTruncation;
}

export interface FooterLayoutDecision {
  id: string;
  outcome: "visible" | "truncated";
  reason: string;
}

export interface FooterLayoutResult {
  lines: string[];
  decisions: FooterLayoutDecision[];
  consumedStatusIds: string[];
  duplicates: string[];
  widgetErrors: FooterWidgetRenderError[];
}

export interface FooterWidgetRenderError {
  id: string;
  message: string;
}

export interface ProtocolErrorRecord {
  class: string;
  message: string;
  timestamp: number;
}

export type FooterLifecycleState =
  | "starting"
  | "active"
  | "disabled"
  | "replaced"
  | "stopped";

export interface FooterRenderState {
  builtins: ReadonlyMap<string, LiveWidget>;
  rich: ReadonlyMap<string, LiveWidget>;
  config: FooterConfig;
  nativeStatuses: ReadonlyMap<string, string>;
}

export type FooterTheme = Pick<Theme, "bold" | "fg">;
