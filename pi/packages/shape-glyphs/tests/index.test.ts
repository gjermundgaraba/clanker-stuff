import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { manifest, RUBIK, wireframe } from "../index.js";

describe("shape glyphs", () => {
  it("draws each frame as its font codepoint over two terminal columns", () => {
    const orb = wireframe("orb", "cyan", "light");
    const source = manifest.animations.orb.cyan.light;

    expect(orb.frames.map((frame) => frame.codePointAt(0))).toStrictEqual(
      source.frames
    );
    expect(orb.still.codePointAt(0)).toBe(source.still);
    expect(RUBIK.frames.map((frame) => frame.codePointAt(0))).toStrictEqual(
      manifest.rubik.frames
    );

    for (const frame of [...orb.frames, orb.still, ...RUBIK.frames]) {
      expect(visibleWidth(frame)).toBe(2);
    }
  });

  it("builds each wireframe once", () => {
    expect(wireframe("orb", "cyan", "light")).toBe(
      wireframe("orb", "cyan", "light")
    );
    expect(wireframe("orb", "cyan", "dark")).not.toBe(
      wireframe("orb", "cyan", "light")
    );
  });
});
