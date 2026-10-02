import { readComparison } from "./comparison.mjs";
import { readFileSync } from "node:fs";
import { validateNativeCodex } from "./native-codex.mjs";
import { validateToolMode } from "./tool-mode-core.mjs";

/** @type {unknown} */
let trajectory;

try {
  trajectory = JSON.parse(
    readFileSync(process.env.EVAL_TRAJECTORY ?? "/logs/agent/trajectory.json", "utf8"),
  );
} catch {
  // Oracle and baseline checks have no runtime evidence.
}

// The two platform manifests are disjoint. Both validators fail closed for malformed
// containers, so classification does not need a second partial manifest decoder.
const comparison = readComparison();

const native = validateNativeCodex(trajectory, comparison);

process.stdout.write(
  JSON.stringify(native.valid_experiment === 1 ? native : validateToolMode(trajectory, comparison)),
);
