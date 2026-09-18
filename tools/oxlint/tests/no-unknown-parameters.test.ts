import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

describe("unknown parameters require real boundaries, not magic names", () => {
  it.each(["value", "cause", "error"])("rejects an unexplained %s parameter", (name) => {
    const result = lint(`function inspect(${name}: unknown) { return String(${name}); }`);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("anti-slop(no-unknown-parameters)");
  });

  it.each([
    'function isText(value: unknown): value is string { return typeof value === "string"; }',
    "// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript may throw any value.\nfunction describeError(error: unknown) { return error instanceof Error ? error.message : String(error); }",
  ])("allows an explicit predicate or explained boundary: %s", (source) => {
    const result = lint(source);
    expect(result.status, result.stdout).toBe(0);
  });
});
