import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

describe("runtime typeof boundary policy", () => {
  it.each([
    'function isText(value: unknown): value is string { return typeof value === "string"; }',
    'function assertText(value: unknown): asserts value is string { if (typeof value !== "string") throw new Error("Expected text"); }',
    'declare const optionalGlobal: string | undefined; const available = typeof optionalGlobal !== "undefined";',
    '// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Discriminate the declared union, not raw input.\nfunction label(value: string | number) { return typeof value === "string" ? value : String(value); }',
  ])("accepts a guard, existence probe, or justified exception: %s", (source) => {
    const result = lint(source);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
  });

  it.each([
    'function label(value: string | number) { return typeof value === "string" ? value : String(value); }',
    'function inspect(cause: unknown) { return typeof cause === "string"; }',
    'function isText(value: unknown): value is string { const inspect = () => typeof value === "string"; return inspect(); }',
  ])("still rejects checks outside explicit guards: %s", (source) => {
    const result = lint(source);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("anti-slop(no-runtime-typeof)");
  });

  it("rejects an exception after its check has been removed", () => {
    const result = lint(
      '// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Former runtime check.\nexport const label = "already typed";',
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toMatch(/unused|not used/iu);
  });
});
