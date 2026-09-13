import { readFileSync } from "node:fs";
import { validateNativeAstra } from "./native-astra.mjs";
import { validateToolMode } from "./tool-mode.mjs";
let trajectory;
try {
  trajectory = JSON.parse(
    readFileSync(process.env.EVAL_TRAJECTORY ?? "/logs/agent/trajectory.json", "utf8"),
  );
} catch {
  // Oracle and baseline checks have no runtime evidence.
}
const validate =
  trajectory?.agent?.extra?.pi_evals?.platform === "codex-native"
    ? validateNativeAstra
    : validateToolMode;
process.stdout.write(JSON.stringify(validate(trajectory)));
