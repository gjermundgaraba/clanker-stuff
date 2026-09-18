import path from "node:path";

import { defineConfig } from "vite-plus";

const rootDir = import.meta.dirname;

// Evaluation caches and raw runs contain third-party source, not workspace tests.
const exclude = ["**/node_modules/**", "**/dist/**", "**/.cache/**", "**/.harbor/**"];

const ignorePatterns = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "tools/oxlint/anti-slop/**",
];

export default defineConfig({
  fmt: { ignorePatterns },
  lint: {
    ignorePatterns,
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      // Pinned source: tools/oxlint/anti-slop/UPSTREAM; local policy: UPSTREAM.md beside it.
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "deny",
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      // Pipeline spelling does not establish performance or preserve callback semantics.
      "anti-slop/no-array-filter-map": "off",
      "anti-slop/no-chained-type-assertions": "error",
      // Conditional spread preserves absent optional properties without mutable builders.
      "anti-slop/no-conditional-empty-object-spread": "off",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      // Keep parsing at boundaries; legitimate narrowing exceptions follow docs/lint-policy.md.
      "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
      // Domain ownership is not determined by a substring.
      "anti-slop/no-shape-in-symbol-names": "off",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    clearMocks: true,
    environment: "node",
    exclude,
    projects: [
      {
        extends: true,
        test: {
          exclude: [...exclude, "**/*.integration.test.ts", "**/*.smoke.test.ts"],
          include: ["**/*.test.ts"],
          name: "unit",
        },
      },
      {
        extends: true,
        test: {
          fileParallelism: false,
          include: ["**/*.integration.test.ts"],
          name: "integration",
        },
      },
      {
        extends: true,
        test: {
          fileParallelism: false,
          include: ["**/*.smoke.test.ts"],
          name: "smoke",
        },
      },
    ],
    restoreMocks: true,
    setupFiles: [path.resolve(rootDir, "pi/tests/harness/setup.ts")],
    testTimeout: 10_000,
  },
});
