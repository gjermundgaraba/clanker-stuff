import path from "node:path";

import { defineConfig } from "vitest/config";

const rootDir = import.meta.dirname;
const exclude = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    exclude,
    projects: [
      {
        extends: true,
        test: {
          exclude: [
            ...exclude,
            "**/*.integration.test.ts",
            "**/*.smoke.test.ts",
          ],
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
