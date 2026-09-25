import { describe, expect, it } from "vite-plus/test";

import { parseRollingFont } from "../font.js";
import { fontManifest } from "./fixtures.js";

import { canRoll, digitTransition, RollingNumbers } from "../rolling.js";

describe("counter transitions", () => {
  it.each([
    ["370", "380", true],
    ["99", "12", true],
    ["1.0k", "1.1k", true],
    ["0.3300", "0.3400", true],
    ["9", "10", false],
    ["999", "1.0k", false],
    ["1.0k", "1000", false],
    ["unknown", "≈1.0k", false],
    ["1.0k", "1.0k", false],
  ])("%s → %s rolls: %s", (before, text, expected) => {
    expect(canRoll(before, text)).toBe(expected);
  });
});

describe("odometer wheels", () => {
  it("passes through intermediate digits at the same speed for uncapped distances", () => {
    expect(digitTransition("1", "2", 0, 130)).toEqual({
      before: "1",
      after: "2",
      progress: 0.5,
    });
    expect(digitTransition("1", "4", 0, 130)).toEqual({
      before: "1",
      after: "2",
      progress: 0.5,
    });
    expect(digitTransition("1", "4", 0, 390)).toEqual({
      before: "2",
      after: "3",
      progress: 0.5,
    });
    expect(digitTransition("1", "4", 0, 650)).toEqual({
      before: "3",
      after: "4",
      progress: 0.5,
    });
    expect(digitTransition("1", "2", 0, 260)).toBeUndefined();
    expect(digitTransition("1", "4", 0, 780)).toBeUndefined();
  });

  it("lets shorter wheels finish first and wraps through zero in the value's direction", () => {
    expect(digitTransition("18", "21", 1, 390)).toEqual({
      before: "9",
      after: "0",
      progress: 0.5,
    });
    expect(digitTransition("18", "21", 0, 650)).toBeUndefined();
    expect(digitTransition("18", "21", 1, 650)).toEqual({
      before: "0",
      after: "1",
      progress: 0.5,
    });
    expect(digitTransition("21", "18", 1, 390)).toEqual({
      before: "0",
      after: "9",
      progress: 0.5,
    });
    expect(digitTransition("8", "5", 0, 390)).toEqual({
      before: "7",
      after: "6",
      progress: 0.5,
    });
    expect(digitTransition("1:59", "2:00", 2, 130)).toEqual({
      before: "5",
      after: "0",
      progress: 0.5,
    });
    expect(digitTransition("1:59", "2:00", 2, 260)).toBeUndefined();
    expect(digitTransition("1.0k", "1.9k", 1, 130)).toBeUndefined();
    expect(digitTransition("1.0k", "1.9k", 0, 130)).toBeUndefined();
  });

  it("caps long rolls at 900 ms without skipping intermediate digits in the path", () => {
    for (let digit = 0; digit < 9; digit++) {
      expect(digitTransition("0", "9", 0, digit * 100)).toEqual({
        before: String(digit),
        after: String(digit + 1),
        progress: 0,
      });
    }

    expect(digitTransition("0", "9", 0, 899)).toMatchObject({ before: "8", after: "9" });
    expect(digitTransition("0", "9", 0, 900)).toBeUndefined();
  });
});

describe("observed numeric fields", () => {
  it("uses the same observation time for durations and counters, then settles", () => {
    const font = parseRollingFont(fontManifest());
    const motion = new RollingNumbers();

    const render = (now: number, value: string) =>
      motion.frame(now, font, (number) => [
        number("active", value + "s"),
        number("wall", value + "s"),
        number("tools", value),
      ]);

    expect(render(1130, "1")).toEqual({ lines: ["1s", "1s", "1"], animated: false });
    expect(render(2100, "2")).toEqual({ lines: ["1s", "1s", "1"], animated: true });
    const mid = font.glyph("1", "2", 0.5);
    expect(render(2230, "2")).toEqual({ lines: [mid + "s", mid + "s", mid], animated: true });
    expect(render(2360, "2")).toEqual({ lines: ["2s", "2s", "2"], animated: false });
  });

  it("forgets fields no longer requested, and reset drops all history", () => {
    const font = parseRollingFont(fontManifest());
    const motion = new RollingNumbers();
    motion.frame(0, font, (number) => [number("tools", "1")]);
    motion.frame(10, font, () => []);
    expect(motion.frame(20, font, (number) => [number("tools", "2")]).animated).toBe(false);
    expect(motion.frame(30, font, (number) => [number("tools", "3")]).animated).toBe(true);
    motion.reset();
    expect(motion.frame(40, font, (number) => [number("tools", "4")])).toEqual({
      lines: ["4"],
      animated: false,
    });
  });
});
