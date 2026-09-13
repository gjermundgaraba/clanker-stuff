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
      // Vendored from https://github.com/dmmulroy/anti-slop at 446268e.
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "deny",
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        files: ["pi/extensions/experimental/shape-spinner/**/*.{ts,mjs}"],
        // Shape is the geometric domain here, not a structural placeholder.
        rules: { "anti-slop/no-shape-in-symbol-names": "off" },
      },
    ],
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
