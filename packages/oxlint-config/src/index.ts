import path from "node:path";
import { fileURLToPath } from "node:url";

import { recommended as effect } from "@effect/tsgo/oxlint-presets";
import type {
  DummyRuleMap,
  ExternalPluginEntry,
  OxlintConfig,
  OxlintEnv,
  OxlintOverride,
} from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export interface Options {
  /** Presets applied after core and anti-slop, before Vitest and Effect, such as `ultracite/oxlint/solid`. */
  readonly extends?: readonly OxlintConfig[];
  readonly jsPlugins?: readonly ExternalPluginEntry[];
  /** Functions that open a test: `expect` may appear inside, and the body must assert. */
  readonly testBlocks?: readonly string[];
  /** Functions where `expect` may appear without the body having to assert, such as `it.effect.each`. */
  readonly expectBlocks?: readonly string[];
  /** Assertion helpers beyond `expect`, `expectTypeOf`, `assert` and `assert.*`. */
  readonly assertFunctions?: readonly string[];
  readonly env?: OxlintEnv;
  readonly ignorePatterns?: readonly string[];
  readonly rules?: DummyRuleMap;
  readonly overrides?: readonly OxlintOverride[];
}

const commentsPlugin = fileURLToPath(
  new URL(`plugin${path.extname(import.meta.url)}`, import.meta.url)
);

const testFiles = [
  "**/*.{test,spec,test-d,spec-d}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  "**/__tests__/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
];

const moduleMock =
  "Replace dependencies through Layers or real interfaces, not module mocks.";

const sharedRules: DummyRuleMap = {
  "sort-keys": "off",
  "max-classes-per-file": "off",
  "no-await-in-loop": "off",
  "require-await": "off",
  "typescript/consistent-return": "off",
  "no-use-before-define": [
    "error",
    { classes: false, functions: false, ignoreTypeReferences: true },
  ],
  complexity: "off",
  "max-nested-callbacks": "off",
  "no-bitwise": "off",
  "unicorn/filename-case": [
    "error",
    { cases: { kebabCase: true, pascalCase: true } },
  ],
  "anti-slop/no-conditional-empty-object-spread": "off",
  "func-names": ["error", "as-needed", { generators: "never" }],
  "no-redeclare": "off",
  "promise/prefer-await-to-then": "off",
  "promise/prefer-await-to-callbacks": "off",
  "typescript/array-type": [
    "error",
    { default: "array-simple", readonly: "array-simple" },
  ],
  "unicorn/no-array-method-this-argument": "off",
  "unicorn/throw-new-error": "off",
  "effecttsgo/unstable-api-usage": "off",
  "anti-slop/require-safety-comment-for-type-assertion": "off",
  "anti-slop/no-unknown-parameters": "off",
  "anti-slop/no-unknown-returns": "off",
  "jsdoc/require-param-description": "off",
  "jsdoc/require-property-description": "off",
  "jsdoc/require-returns-description": "off",
  "jsdoc/require-throws-description": "off",
  "jsdoc/require-yields-description": "off",
  "unicorn/text-encoding-identifier-case": "off",
  "no-inline-comments": [
    "error",
    {
      ignorePattern: String.raw`^(?:\*\s*@(?:type|satisfies|param|returns)\b|\s*[@#]__(?:PURE|NO_SIDE_EFFECTS)__\s*$|\s*@vite-ignore\s*$|\s*webpack)`,
    },
  ],
  "default-case": "off",
  "typescript/switch-exhaustiveness-check": "error",
  "unicorn/no-useless-undefined": "off",
  "no-useless-return": "off",
  "vite-plus/prefer-vite-plus-imports": "error",
  "clanker/no-prose-comments": "error",
};

const testOverride = (options: Options): OxlintOverride => {
  const testBlocks = [...(options.testBlocks ?? [])];

  return {
    files: testFiles,
    plugins: ["vitest"],
    rules: {
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            ...testBlocks,
            ...(options.expectBlocks ?? []),
          ],
        },
      ],
      "vitest/expect-expect": [
        "error",
        {
          additionalTestBlockFunctions: testBlocks,
          assertFunctionNames: [
            "expect",
            "expectTypeOf",
            "assert",
            "assert.*",
            ...(options.assertFunctions ?? []),
          ],
        },
      ],
      "vitest/prefer-describe-function-title": "off",
      "typescript/no-non-null-assertion": "off",
      "vitest/max-expects": "off",
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/prefer-to-be-truthy": "off",
      "vitest/prefer-to-be-falsy": "off",
      "no-script-url": "off",
      "no-template-curly-in-string": "off",
      "vitest/no-restricted-vi-methods": [
        "error",
        { doMock: moduleMock, mock: moduleMock },
      ],
    },
  };
};

/** The full Oxlint config: Ultracite core, anti-slop and Vitest, Effect's recommended preset, the shared exceptions, then the repository's own values. */
export const config = (options: Options = {}): OxlintConfig => ({
  env: { node: true, ...options.env },
  extends: [core, antiSlop, ...(options.extends ?? []), vitest, effect],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ...(options.ignorePatterns ?? []),
  ],
  jsPlugins: [
    { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
    { name: "clanker", specifier: commentsPlugin },
    ...(options.jsPlugins ?? []),
  ],
  options: {
    typeAware: true,
    typeCheck: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
  },
  overrides: [testOverride(options), ...(options.overrides ?? [])],
  rules: { ...sharedRules, ...options.rules },
});
