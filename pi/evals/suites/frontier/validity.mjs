import { readFileSync } from "node:fs";

import { readComparison } from "./comparison.mjs";
import { validateNativeCodex } from "./native-codex.mjs";
import { validateToolMode } from "./tool-mode-core.mjs";

const readTrajectory = () => {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(
      readFileSync(
        process.env["EVAL_TRAJECTORY"] ?? "/logs/agent/trajectory.json",
        "utf-8"
      )
    );

    return parsed;
  } catch {
    return undefined;
  }
};

const trajectory = readTrajectory();

const comparison = readComparison();

const native = validateNativeCodex(trajectory, comparison);

process.stdout.write(
  JSON.stringify(
    native.valid_experiment === 1
      ? native
      : validateToolMode(trajectory, comparison)
  )
);
