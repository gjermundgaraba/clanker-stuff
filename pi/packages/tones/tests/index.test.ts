import { describe, expect, it } from "vite-plus/test";

import { percentTone } from "../index.js";

describe("tones", () => {
  it("keeps usage meters neutral until they need attention", () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(percentTone)).toEqual([
      "text",
      "text",
      "warning",
      "warning",
      "error",
      "error",
    ]);
  });
});
