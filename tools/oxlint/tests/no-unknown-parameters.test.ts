import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

describe("unknown inputs at TypeScript boundaries", () => {
  it.each([
    "function describeError(error: unknown) { return error instanceof Error ? error.message : String(error); }",
    "function serialize(value: unknown) { return JSON.stringify(value); }",
  ])("accepts opaque inputs without exceptions: %s", (source) => {
    const result = lint(source);
    expect(result.status, result.stdout).toBe(0);
  });
});
