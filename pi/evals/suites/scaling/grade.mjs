import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fixture, FIXTURE, SERVICE_NAMES } from "/opt/codex-provider/services.mjs";
import { oracle, score, serviceMetrics } from "./scoring.mjs";
import { validateToolMode } from "./tool-mode.mjs";
import { validateNativeDiagnostic } from "./validity.mjs";
const logs = process.env.EVAL_LOGS ?? "/logs/verifier";
mkdirSync(logs, { recursive: true });
function read(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
const events = read(process.env.EVAL_EVENTS ?? "/logs/agent/service-events.jsonl", "")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const trajectory = JSON.parse(
  read(process.env.EVAL_TRAJECTORY ?? "/logs/agent/trajectory.json", "null"),
);
const submitted = events.findLast((e) => e.type === "pi_eval_submission")?.report ?? null;
const metrics = serviceMetrics(events);
const setups = events.filter((e) => e.type === "pi_eval_diagnostic");
const setupValid =
  setups.length === 1 &&
  setups[0].fixture === FIXTURE &&
  setups[0].latency_ms === 150 &&
  setups[0].mode === trajectory?.agent?.extra?.pi_evals?.tool_mode &&
  JSON.stringify(setups[0].nestedTools) === JSON.stringify(SERVICE_NAMES);
const valid =
  trajectory?.agent?.extra?.pi_evals?.platform === "codex-native"
    ? validateNativeDiagnostic(trajectory, events)
    : validateToolMode(trajectory).valid_experiment === 1 && setupValid && metrics.ledger_complete;
const reward = {
  ...score(submitted, oracle(fixture()), events),
  valid_experiment: Number(valid),
};
for (const [name, value] of Object.entries({ reward, metrics, submitted }))
  writeFileSync(`${logs}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
console.log(JSON.stringify({ reward, metrics }));
