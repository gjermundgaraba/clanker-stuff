import { expect, it } from "vite-plus/test";
import { Value } from "typebox/value";
import { GlyphMapSchema, IconFamilySchema, selectGlyph } from "../index.js";

it("selects one shared fallback policy for every status renderer", () => {
  const glyphs = { ascii: "mail", unicode: "✉", nerd: "\uF0E0" };
  expect(selectGlyph(glyphs, "nerd")).toBe("\uF0E0");
  expect(selectGlyph(glyphs, "unicode")).toBe("✉");
  expect(selectGlyph(glyphs, "ascii")).toBe("mail");
  expect(selectGlyph({ unicode: "✉", ascii: "mail" }, "nerd")).toBe("✉");
  expect(selectGlyph({ ascii: "mail" }, "unicode")).toBe("mail");
  expect(selectGlyph({ nerd: "\uF0E0" }, "ascii")).toBe("");
  expect(selectGlyph(undefined, "nerd")).toBe("");
  expect(selectGlyph({ nerd: "", unicode: "✉" }, "nerd")).toBe("");
});

it("validates families and bounded glyph maps", () => {
  for (const family of ["ascii", "unicode", "nerd"])
    expect(Value.Check(IconFamilySchema, family)).toBe(true);
  expect(Value.Check(IconFamilySchema, "emoji")).toBe(false);
  expect(Value.Check(GlyphMapSchema, { unicode: "✉" })).toBe(true);
  expect(Value.Check(GlyphMapSchema, { emoji: "✉" })).toBe(false);
  expect(Value.Check(GlyphMapSchema, { ascii: "a".repeat(17) })).toBe(false);
});
