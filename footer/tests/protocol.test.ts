import { describe, expect, it } from "vitest";

import {
  validateFooterWidgetMessage,
  validateFooterWidgetSnapshot,
} from "../protocol.js";

describe("protocol validation", () => {
  const snapshot = {
    content: [{ text: "ok", tone: "success" }],
    id: "example.widget",
    label: "Example",
  } as const;

  it("strictly validates rich snapshots and messages", () => {
    expect(validateFooterWidgetSnapshot(snapshot).ok).toBeTruthy();
    expect(
      validateFooterWidgetMessage({
        instanceId: "host",
        protocol: 1,
        type: "upsert",
        widget: snapshot,
      }).ok
    ).toBeTruthy();
    expect(
      validateFooterWidgetSnapshot({
        ...snapshot,
        content: [{ text: "\u001B[31munsafe" }],
      }).ok
    ).toBeFalsy();
    expect(
      validateFooterWidgetSnapshot({ ...snapshot, extra: true }).ok
    ).toBeFalsy();
  });

  it("copies validated icon glyph maps", () => {
    const glyphs = { ascii: "A" };
    const result = validateFooterWidgetSnapshot({
      ...snapshot,
      icon: { glyphs },
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    glyphs.ascii = "B";
    const { icon } = result.value;
    if (
      icon === undefined ||
      icon === false ||
      typeof icon.glyphs === "string"
    ) {
      throw new Error("expected glyph map");
    }

    expect(icon.glyphs.ascii).toBe("A");
  });

  it("validates optional truncation hints", () => {
    expect(
      validateFooterWidgetSnapshot({ ...snapshot, truncate: "middle" }).ok
    ).toBeTruthy();
    expect(
      validateFooterWidgetSnapshot({ ...snapshot, truncate: "sideways" }).ok
    ).toBeFalsy();
  });
});
