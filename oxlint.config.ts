import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

const coreIgnore = Array.isArray(core.ignorePatterns)
  ? core.ignorePatterns
  : [];

const asyncStyleRules = {
  "require-await": "off",
  "typescript/promise-function-async": "off",
} as const;

const testBoundaryRules = {
  "typescript/consistent-return": "off",
  "typescript/no-confusing-void-expression": "off",
  "typescript/no-misused-promises": "off",
  "typescript/no-misused-spread": "off",
  "typescript/no-redundant-type-constituents": "off",
  "typescript/no-unnecessary-type-assertion": "off",
  "typescript/no-unnecessary-type-parameters": "off",
  "typescript/no-unsafe-assignment": "off",
  "typescript/no-unsafe-call": "off",
  "typescript/no-unsafe-member-access": "off",
  "typescript/no-unsafe-return": "off",
  "typescript/no-unsafe-type-assertion": "off",
  "typescript/return-await": "off",
  "typescript/strict-boolean-expressions": "off",
  "typescript/strict-void-return": "off",
  "unbound-method": "off",
} as const;

/** Full Ultracite core + vitest, with async style left to TypeScript. */
export default defineConfig({
  env: {
    builtin: true,
    node: true,
  },
  extends: [core, vitest],
  ignorePatterns: [...coreIgnore, "scripts/**"],
  overrides: [
    {
      files: [
        "**/*.{test,spec}.ts",
        "**/tests/**/*.ts",
        "tests/harness/**/*.ts",
        "tests/helpers/**/*.ts",
      ],
      plugins: ["vitest"],
      rules: { ...asyncStyleRules, ...testBoundaryRules },
    },
  ],
  rules: asyncStyleRules,
});
