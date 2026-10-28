import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { parseRollingFont } from "../font.js";
import { fontManifest } from "./fixtures.js";

describe("rolling-font manifest", () => {
  it("uses outgoing transition endpoints for stationary companion digits", () => {
    const font = parseRollingFont(fontManifest());

    for (let digit = 0; digit < 10; digit += 1) {
      expect(font.stationary(String(digit))).toBe(
        String.fromCodePoint(0xf_10_00 + digit * 0x1_00)
      );
      expect(visibleWidth(font.stationary(String(digit)))).toBe(1);
    }

    expect(() => font.stationary("x")).toThrow("Unsupported");
  });

  it("samples forward, reverse, decimal and timer carries; zero progress stays ASCII", () => {
    const font = parseRollingFont({
      ...fontManifest(),
      family: "Local font",
      sourceSha256: "metadata",
    });

    expect(font.glyph("0", "1", 0)).toBe("0");
    expect(font.glyph("0", "1", 0.25)).toBe(String.fromCodePoint(0xf_10_02));
    expect(font.glyph("1", "0", 0.75)).toBe(font.glyph("0", "1", 0.25));
    expect(font.glyph("9", "0", 0.5)).toBe(String.fromCodePoint(0xf_19_04));
    expect(font.glyph("5", "0", 0.5)).toBe(String.fromCodePoint(0xf_1a_04));
    expect(font.glyph("0", "5", 0.5)).toBe(font.glyph("5", "0", 0.5));
    expect(visibleWidth(font.glyph("0", "1", 0.5))).toBe(1);
    expect(font.glyph("0", "1", 0.5)).toHaveLength(2);
    expect(() => font.glyph("1", "3", 0.5)).toThrow("Unsupported");
  });

  it.each([1, 8, 32])("reads %i subdivisions from the manifest", (steps) => {
    const font = parseRollingFont(fontManifest(steps));
    expect(font.glyph("0", "1", 0.5)).toBe(
      String.fromCodePoint(0xf_10_00 + Math.round(steps / 2))
    );
  });

  it.each([
    { version: 2 },
    { steps: 0 },
    { steps: 8.5 },
    { steps: 16 },
    { transitions: {} },
    {
      transitions: {
        ...fontManifest().transitions,
        "01": Array.from({ length: 9 }, () => 27),
      },
    },
    {
      transitions: {
        ...fontManifest().transitions,
        "01": Array.from({ length: 9 }, () => 0xf_ff_fe),
      },
    },
    {
      transitions: {
        ...fontManifest().transitions,
        "50": Array.from({ length: 8 }, () => 0xf_20_00),
      },
    },
  ])("rejects malformed or unsafe frame mappings: %j", (patch) => {
    expect(() => parseRollingFont({ ...fontManifest(), ...patch })).toThrow(
      /Invalid rolling-font manifest|Rolling-font transition \w+ must have steps \+ 1 frames/u
    );
  });
});
