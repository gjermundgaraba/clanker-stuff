import { describe, expect, it } from "vite-plus/test";

import { parseMouseInput } from "../mouse.js";

const bounds = { col: 10, row: 2, width: 120, height: 21 };

describe("regular-mode mouse input", () => {
  it("normalizes wheel coordinates and modifiers", () => {
    expect(parseMouseInput("\u001B[<65;91;9M", bounds)).toMatchObject({
      type: "wheel",
      x: 80,
      y: 6,
      screenX: 90,
      screenY: 8,
      wheelDelta: 3,
    });
    expect(parseMouseInput("\u001B[<84;91;9M", bounds)).toMatchObject({
      type: "wheel",
      wheelDelta: -3,
      ctrl: true,
      shift: true,
    });
    expect(parseMouseInput("\u001B[<0;91;9M", bounds)).toMatchObject({
      type: "press",
      button: "left",
    });
  });
  it.each(["x", "\u001B[<65;91;9m", "\u001B[<65;1;1M", "\u001B[<66;91;9M", "\u001B[<32;91;9M"])(
    "ignores non-scroll/press input or input outside the overlay: %s",
    (input) => {
      expect(parseMouseInput(input, bounds)).toBeUndefined();
    },
  );
  it("waits for the first rendered bounds", () => {
    expect(parseMouseInput("\u001B[<65;91;9M", undefined)).toBeUndefined();
  });
});
