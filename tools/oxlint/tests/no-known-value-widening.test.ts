import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

const guard = "declare function isString(value: unknown): value is string;";

describe("known-value evidence follows aliases, not destructuring owners", () => {
  it.each([
    "function check(body: { value: unknown }) { const { value } = body; return isString(value); }",
    "function check(body: { value: unknown }) { const { value: renamed } = body; return isString(renamed); }",
    "function check(body: [unknown]) { const [value] = body; return isString(value); }",
    "function check(body: { nested: { value: unknown } }) { const { nested: { value } } = body; return isString(value); }",
    "function check(body: { value: unknown }) { return isString(body.value); }",
    "declare const raw: unknown; const { value } = { value: raw }; const widened: unknown = value;",
    "declare const raw: unknown; const [value] = [raw]; const widened: unknown = value;",
    "const original = 'known'; const alias = original; isString(alias);",
    "function check(value: string) { return isString(value); }",
    "function check(value: string | number) { return isString(value); }",
    "const user: { name: string } = { name: 'Ada' };",
    "const flags: { [K in 'read' | 'write']: boolean } = { read: true, write: false };",
    "const flags: Record<'read' | 'write', boolean> = { read: true, write: false };",
    "const flags: Record<string, boolean> = {};",
    "declare const brand: unique symbol; type Positive = number & { readonly [brand]: true }; declare function isPositive(value: unknown): value is Positive; function check(value: number) { return isPositive(value); }",
  ])("does not invent member evidence: %s", (source) => {
    const result = lint(`${guard}\n\n${source}`);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
  });

  it.each([
    "const original = { value: 'known' }; const alias = original; const widened: unknown = alias;",
    "const flags: Record<string, boolean> = { read: true, write: false };",
  ])("still reports established evidence: %s", (source) => {
    const result = lint(`${guard}\n\n${source}`);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("discards known type evidence");
  });
});
