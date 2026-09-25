import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const getRollingFontDirectory = (): string =>
  join(getExtensionStoragePaths("turn-recap").dataDir, "rolling-font");

export const getRollingFontPath = (): string => join(getRollingFontDirectory(), "manifest.json");

const Codepoint = Type.Integer({ minimum: 0xf0000, maximum: 0xffffd });

const Frames = Type.Array(Codepoint);

export const ROLLING_PAIRS = [
  ...Array.from({ length: 10 }, (_, digit) => `${digit}${(digit + 1) % 10}`),
  "50",
];

// Decode the widget and preview contract. Builder metadata (family, metrics, licensing
// provenance, install instructions) remains in the manifest but is not consumed.
const Manifest = Type.Object({
  version: Type.Literal(1),
  steps: Type.Integer({ minimum: 1 }),
  transitions: Type.Object(Object.fromEntries(ROLLING_PAIRS.map((pair) => [pair, Frames])), {
    additionalProperties: false,
  }),
});

export interface RollingFont {
  stationary(digit: string): string;
  /** Adjacent, differing digits; progress is in [0, 1). Settlement is the caller's job. */
  glyph(before: string, after: string, progress: number): string;
}

export const parseRollingFont = (value: unknown): RollingFont => {
  if (!Value.Check(Manifest, value)) throw new Error("Invalid rolling-font manifest");
  const frames = new Map<string, string[]>();

  for (const [pair, codepoints] of Object.entries(value.transitions)) {
    if (codepoints.length !== value.steps + 1)
      throw new Error(`Rolling-font transition ${pair} must have steps + 1 frames`);
    frames.set(
      pair,
      codepoints.map((codepoint) => String.fromCodePoint(codepoint)),
    );
  }

  const steps = value.steps;

  return {
    stationary(digit) {
      const glyph = frames.get(digit + String((Number(digit) + 1) % 10))?.[0];

      if (glyph === undefined) throw new Error(`Unsupported rolling-font digit ${digit}`);

      return glyph;
    },
    glyph(before, after, progress) {
      if (progress === 0) return before;
      const forward = frames.get(before + after);
      const sequence = forward ?? frames.get(after + before);
      const glyph = sequence?.[Math.round((forward ? progress : 1 - progress) * steps)];

      // Unsupported digit pairs are a caller error, never invisible missing ink.
      if (glyph === undefined)
        throw new Error(`Unsupported rolling-font transition ${before} → ${after}`);

      return glyph;
    },
  };
};

/** Building the font is the opt-in: no manifest means no animation. */
export const loadRollingFont = async (): Promise<RollingFont | undefined> => {
  let text: string;

  try {
    text = await readFile(getRollingFontPath(), "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }

  return parseRollingFont(JSON.parse(text));
};
