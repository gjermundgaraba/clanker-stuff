import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

const cast = (comment: string) =>
  `export function narrow(value: unknown) {\n  ${comment}\n  return value as string;\n}\n`;

describe("type assertion justifications", () => {
  it("accepts a reasoned unsafe-assertion suppression as the justification", () => {
    const result = lint(
      cast(
        "// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The caller owns a string.",
      ),
    );

    // The temporary file is outside the type-aware program, so only the suppression can be unused.
    expect(result.error).toBeUndefined();
    expect(result.stdout).not.toContain("require-safety-comment-for-type-assertion");
  });

  it.each([
    [
      "an unreasoned unsafe-assertion suppression",
      "// oxlint-disable-next-line typescript/no-unsafe-type-assertion",
    ],
    [
      "a reasoned suppression of another rule",
      "// oxlint-disable-next-line no-console -- Unrelated.",
    ],
  ])("still requires a justification after %s", (_case, comment) => {
    const result = lint(cast(comment));

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("require-safety-comment-for-type-assertion");
  });
});
