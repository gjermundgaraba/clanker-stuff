import { Type } from "typebox";
import type { Static } from "typebox";

export const IconFamilySchema = Type.Union([
  Type.Literal("ascii"),
  Type.Literal("unicode"),
  Type.Literal("nerd"),
]);

export type IconFamily = Static<typeof IconFamilySchema>;

export const GlyphMapSchema = Type.Object(
  {
    ascii: Type.Optional(Type.String({ maxLength: 16 })),
    unicode: Type.Optional(Type.String({ maxLength: 16 })),
    nerd: Type.Optional(Type.String({ maxLength: 16 })),
  },
  { additionalProperties: false },
);

export type GlyphMap = Static<typeof GlyphMapSchema>;

/** Missing variants fall back; an explicit empty string stops fallback and omits the icon. */
export function selectGlyph(glyphs: GlyphMap | undefined, family: IconFamily): string {
  const order: IconFamily[] =
    family === "nerd"
      ? ["nerd", "unicode", "ascii"]
      : family === "unicode"
        ? ["unicode", "ascii"]
        : ["ascii"];

  for (const candidate of order) if (glyphs?.[candidate] !== undefined) return glyphs[candidate];

  return "";
}
