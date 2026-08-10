import { describe, expect, it } from "vitest";

import {
  BREATHING_DOT_FRAMES,
  BREATHING_DOT_INTERVAL_MS,
  STATIC_BREATHING_DOT_FRAME,
} from "../index.js";

describe("motion recipes", () => {
  it("exports an animated breathing dot recipe", () => {
    expect(BREATHING_DOT_INTERVAL_MS).toBeGreaterThan(0);
    expect(BREATHING_DOT_FRAMES.length).toBeGreaterThan(1);
    expect(BREATHING_DOT_FRAMES).toContainEqual(STATIC_BREATHING_DOT_FRAME);
  });
});
