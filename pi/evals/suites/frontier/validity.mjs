import { readFileSync } from "node:fs";
import { validateNativeAstra } from "./native-astra.mjs";
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

// The two strict manifests are disjoint. Both validators fail closed for malformed
// containers, so classification does not need a second partial manifest decoder.
const native = validateNativeAstra(trajectory);

process.stdout.write(
  JSON.stringify(native.valid_experiment === 1 ? native : validateToolMode(trajectory)),
);
