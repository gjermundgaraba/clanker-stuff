import {
  FooterWidgetGlyphMapSchema,
  FooterWidgetMessageSchema,
} from "@clanker-stuff/footer-protocol";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { validateFooterWidgetMessage } from "../protocol-validation.js";

describe("protocol validation", () => {
  const snapshot = {
    content: [{ text: "ok", tone: "success" }],
    id: "example.widget",
    label: "Example",
  } as const;

  it("strictly validates rich snapshots and messages", () => {
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: snapshot,
      }).ok,
    ).toBeTruthy();
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: {
          ...snapshot,
          content: [{ text: "\u001B[31munsafe" }],
        },
      }).ok,
    ).toBeFalsy();
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: { ...snapshot, extra: true },
      }).ok,
    ).toBeFalsy();
  });

  it("copies validated icon glyph maps", () => {
    const glyphs = { ascii: "A" };
    const result = validateFooterWidgetMessage({
      instanceId: "host",
      protocol: 1,
      type: "upsert",
      widget: {
        ...snapshot,
        icon: { glyphs },
      },
    });
    if (!result.ok || result.value.type !== "upsert") {
      throw new Error("expected valid upsert");
    }
    glyphs.ascii = "B";
    const { icon } = result.value.widget;
    if (
      icon === undefined ||
      icon === false ||
      !Value.Check(FooterWidgetGlyphMapSchema, icon.glyphs)
    ) {
      throw new Error("expected glyph map");
    }

    expect(icon.glyphs.ascii).toBe("A");
  });

  it("validates optional truncation hints", () => {
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: { ...snapshot, truncate: "middle" },
      }).ok,
    ).toBeTruthy();
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: { ...snapshot, truncate: "sideways" },
      }).ok,
    ).toBeFalsy();
  });
});

describe("widget message refinements", () => {
  it.each([
    { widget: { id: "footer.reserved", label: "Example", content: [] }, kind: "id" },
    { widget: { id: "example.widget", label: "bad\nlabel", content: [] }, kind: "text" },
    {
      widget: {
        id: "example.widget",
        label: "Example",
        content: [{ text: "x".repeat(600) }, { text: "x".repeat(425) }],
      },
      kind: "content",
    },
    {
      widget: {
        id: "example.widget",
        label: "Example",
        content: [],
        health: { state: "ready", message: "bad\u0085message" },
      },
      kind: "health",
    },
    {
      widget: {
        id: "example.widget",
        label: "Example",
        content: [],
        consumesStatusKeys: ["bad\nkey"],
      },
      kind: "fallback",
    },
    {
      widget: { id: "example.widget", label: "Example", content: [], icon: { glyphs: "\u001b" } },
      kind: "icon",
    },
  ])("retains $kind diagnostics", ({ widget, kind }) => {
    expect(
      validateFooterWidgetMessage({ instanceId: "host", protocol: 1, type: "upsert", widget }),
    ).toMatchObject({ ok: false, class: kind });
  });

  it.each([
    { fields: { label: "a\u0301".repeat(41) }, kind: "text" },
    { fields: { icon: { glyphs: "a\u0301".repeat(9) } }, kind: "icon" },
    { fields: { icon: { glyphs: { unicode: "a\u0301".repeat(9) } } }, kind: "icon" },
    { fields: { health: { state: "ready", message: "a\u0301".repeat(257) } }, kind: "health" },
    { fields: { consumesStatusKeys: ["a\u0301".repeat(65)] }, kind: "fallback" },
    { fields: { content: [{ text: "a\u0301".repeat(513) }] }, kind: "content" },
  ])("rejects excessive $kind code points despite valid grapheme length", ({ fields, kind }) => {
    const message = {
      instanceId: "host",
      protocol: 1,
      type: "upsert",
      widget: { id: "example.widget", label: "Example", content: [], ...fields },
    };
    expect(Value.Check(FooterWidgetMessageSchema, message)).toBe(true);
    expect(validateFooterWidgetMessage(message)).toMatchObject({ ok: false, class: kind });
  });

  it("copies all mutable fields and counts aggregate code points", () => {
    const widget = {
      id: "example.widget",
      label: "🦄".repeat(80),
      content: [{ text: "🦄".repeat(512) }, { text: "🦄".repeat(512) }],
      defaults: { enabled: true },
      health: { state: "ready" as const, message: "ready" },
      consumesStatusKeys: ["native"],
    };
    const result = validateFooterWidgetMessage({
      instanceId: "host",
      protocol: 1,
      type: "upsert",
      widget,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== "upsert") throw new Error("expected upsert");
    widget.content[0].text = "changed";
    widget.defaults.enabled = false;
    widget.health.message = "changed";
    widget.consumesStatusKeys[0] = "changed";
    expect(result.value.widget.content[0]?.text).toBe("🦄".repeat(512));
    expect(result.value.widget.defaults?.enabled).toBe(true);
    expect(result.value.widget.health?.message).toBe("ready");
    expect(result.value.widget.consumesStatusKeys).toStrictEqual(["native"]);
  });
});
