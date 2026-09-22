import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

describe("runtime typeof boundary policy", () => {
  it.each([
    'function isText(value: unknown): value is string { return typeof value === "string"; }',
    'declare const optionalGlobal: string | undefined; const available = typeof optionalGlobal !== "undefined";',
    'function label(value: string | number) { return typeof value === "string" ? value : String(value); }',
    'function inspect(cause: unknown) { return typeof cause === "string"; }',
  ])("accepts ordinary narrowing without exceptions: %s", (source) => {
    const result = lint(source);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
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
