import { FOOTER_PROTOCOL_VERSION, FooterWidgetMessageSchema } from "@clanker-stuff/footer-protocol";
import type {
  FooterContent,
  FooterSpan,
  FooterWidgetHealth,
  FooterWidgetIcon,
  FooterWidgetMessage,
  FooterWidgetSnapshot,
} from "@clanker-stuff/footer-protocol";
import { Value } from "typebox/value";

import { hasTerminalControl } from "@clanker-stuff/footer-protocol/config";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; class: string; message: string };

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/u;

const codePointLength = (value: string): number => {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
  }
  return length;
};

const validText = (value: string, maximum: number): boolean =>
  codePointLength(value) <= maximum && !hasTerminalControl(value);

export const validateRichWidgetId = (value: string): boolean =>
  ID_PATTERN.test(value) && !value.startsWith("footer.") && !value.startsWith("status:");

const copyContent = (value: FooterContent): FooterContent | undefined => {
  const spans: FooterSpan[] = [];
  let length = 0;
  for (const candidate of value) {
    if (hasTerminalControl(candidate.text)) {
      return undefined;
    }
    length += codePointLength(candidate.text);
    if (length > 1024) {
      return undefined;
    }
    spans.push({ ...candidate });
  }
  return spans;
};

const copyIcon = (value: FooterWidgetIcon | false): FooterWidgetIcon | false | undefined => {
  if (value === false) {
    return false;
  }
  if (typeof value.glyphs !== "string") {
    if (Object.values(value.glyphs).some((glyph) => glyph !== undefined && !validText(glyph, 16))) {
      return undefined;
    }
    return { ...value, glyphs: { ...value.glyphs } };
  }
  return validText(value.glyphs, 16) ? { ...value } : undefined;
};

const copyHealth = (value: FooterWidgetHealth): FooterWidgetHealth | undefined =>
  value.message === undefined || validText(value.message, 512) ? { ...value } : undefined;

const validateSnapshot = (value: FooterWidgetSnapshot): ValidationResult<FooterWidgetSnapshot> => {
  if (!validateRichWidgetId(value.id)) {
    return {
      class: "id",
      message: "widget id is invalid or reserved",
      ok: false,
    };
  }
  if (!validText(value.label, 80)) {
    return { class: "text", message: "widget label is invalid", ok: false };
  }
  const content = copyContent(value.content);
  if (!content) {
    return {
      class: "content",
      message: "widget content is invalid",
      ok: false,
    };
  }
  const icon = value.icon === undefined ? undefined : copyIcon(value.icon);
  if (value.icon !== undefined && icon === undefined) {
    return { class: "icon", message: "widget icon is invalid", ok: false };
  }
  const health = value.health === undefined ? undefined : copyHealth(value.health);
  if (value.health !== undefined && health === undefined) {
    return { class: "health", message: "widget health is invalid", ok: false };
  }
  if (value.consumesStatusKeys?.some((key) => !validText(key, 128)) === true) {
    return {
      class: "fallback",
      message: "consumed status keys are invalid",
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      ...value,
      consumesStatusKeys:
        value.consumesStatusKeys === undefined ? undefined : [...value.consumesStatusKeys],
      content,
      defaults: value.defaults === undefined ? undefined : { ...value.defaults },
      health,
      icon,
    },
  };
};

export const validateFooterWidgetMessage = (
  value: unknown,
): ValidationResult<FooterWidgetMessage> => {
  if (!Value.Check(FooterWidgetMessageSchema, value)) {
    return {
      class: "message",
      message: "widget message must match the protocol schema",
      ok: false,
    };
  }
  if (value.type === "remove") {
    return validateRichWidgetId(value.id)
      ? {
          ok: true,
          value: {
            ...value,
            protocol: FOOTER_PROTOCOL_VERSION,
          },
        }
      : { class: "id", message: "widget id is invalid or reserved", ok: false };
  }
  const widget = validateSnapshot(value.widget);
  return widget.ok
    ? {
        ok: true,
        value: {
          ...value,
          protocol: FOOTER_PROTOCOL_VERSION,
          widget: widget.value,
        },
      }
    : widget;
};
