import path from "node:path";

import { defineConfig } from "vite-plus";

import fmt from "./oxfmt.config.ts";
import lint from "./oxlint.config.ts";

const rootDir = import.meta.dirname;

// Evaluation caches and raw runs contain third-party source, not workspace tests.
const exclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.cache/**",
  "**/.harbor/**",
];

export default defineConfig({
  fmt,
  lint,
  run: {
    tasks: {
      // Static checks cache on the files they read; `ready` fans them out, then tests.
      "check:packages": {
        command: "node ./scripts/check-package-readiness.ts",
      },
      "check:readmes": { command: "node ./scripts/check-readmes.ts" },
      "check:skills": {
        command:
          "python3 -B -m unittest discover -s skills/diagram-design/scripts && python3 -B -m unittest discover -s skills/librarian/tests && python3 -B -m unittest discover -s skills/tui-ux-tester/scripts && python3 -B -m unittest discover -s skills/skill-doctor/scripts",
      },
      "check:static": { command: "vp check" },
      "check:tests": { command: "node ./scripts/check-tests.ts" },
      ready: {
        cache: false,
        command: "vp test",
        dependsOn: [
          "check:static",
          "check:packages",
          "check:readmes",
          "check:tests",
          "check:skills",
        ],
      },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    environment: "node",
    exclude,
    projects: [
      {
        test: {
          exclude: ["**/*.integration.test.ts", "**/*.smoke.test.ts"],
          include: ["**/*.test.ts"],
          name: "unit",
        },
      },
      {
        test: {
          include: ["**/*.integration.test.ts"],
          name: "integration",
        },
      },
      {
        test: {
          fileParallelism: false,
          hookTimeout: 120_000,
          include: ["**/*.smoke.test.ts"],
          name: "smoke",
          testTimeout: 120_000,
        },
      },
    ],
    restoreMocks: true,
    setupFiles: [path.resolve(rootDir, "pi/tests/harness/setup.ts")],
    testTimeout: 10_000,
  },
});
