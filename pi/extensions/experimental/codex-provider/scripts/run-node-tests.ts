import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const SummarySchema = Type.Object({
  counts: Type.Object({
    failed: Type.Integer({ minimum: 0 }),
    passed: Type.Integer({ minimum: 0 }),
    tests: Type.Integer({ minimum: 0 }),
  }),
  success: Type.Boolean(),
});

const reporter = fileURLToPath(new URL("./test-summary-reporter.ts", import.meta.url));

/** Keep evaluated tests in a subprocess, with a separate machine-only reporter stream. */
export const runNodeTests = (cwd: string, timeout = 60_000) => {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stderr",
      `--test-reporter=${reporter}`,
      "--test-reporter-destination=stdout",
    ],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout },
  );

  let summary: Static<typeof SummarySchema> | undefined;

  try {
    const value: unknown = JSON.parse(result.stdout ?? "");

    if (Value.Check(SummarySchema, value)) {
      summary = value;
    }
  } catch {
    // A timeout or runner startup failure can leave the summary absent or incomplete.
  }

  return { output: result.stderr ?? "", status: result.status, summary };
};
