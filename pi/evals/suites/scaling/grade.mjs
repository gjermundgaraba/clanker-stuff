import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fixture, FIXTURE, SERVICE_NAMES } from "/opt/codex-provider/services.mjs";
import { isRecord } from "./service-metrics.mjs";
import { oracle, score, serviceMetrics } from "./scoring.mjs";
import { validateToolMode } from "./tool-mode.mjs";
import { validateNativeDiagnostic } from "./validity.mjs";

const logs = process.env.EVAL_LOGS ?? "/logs/verifier";

mkdirSync(logs, { recursive: true });

/** @param {string} path @param {string} fallback */
function read(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

/** @type {unknown[]} */
const events = read(process.env.EVAL_EVENTS ?? "/logs/agent/service-events.jsonl", "")
  .split("\n")
  .filter(Boolean)
  .map(/** @returns {unknown} */ (line) => JSON.parse(line));

/** @type {unknown} */
const trajectory = JSON.parse(
  read(process.env.EVAL_TRAJECTORY ?? "/logs/agent/trajectory.json", "null"),
);

const records = events.filter(isRecord);

const agent = isRecord(trajectory) && isRecord(trajectory.agent) ? trajectory.agent : undefined;

const extra = isRecord(agent?.extra) ? agent.extra : undefined;

const manifest = isRecord(extra?.pi_evals) ? extra.pi_evals : undefined;

const submitted = records.findLast((e) => e.type === "pi_eval_submission")?.report ?? null;

const metrics = serviceMetrics(events);

const setups = records.filter((e) => e.type === "pi_eval_diagnostic");

const [setup] = setups;

const setupValid =
  setups.length === 1 &&
  setup !== undefined &&
  setup.fixture === FIXTURE &&
  setup.latency_ms === 150 &&
  setup.mode === manifest?.tool_mode &&
  JSON.stringify(setup.nestedTools) === JSON.stringify(SERVICE_NAMES);

const valid =
  manifest?.platform === "codex-native"
    ? validateNativeDiagnostic(trajectory, events)
    : validateToolMode(trajectory).valid_experiment === 1 && setupValid && metrics.ledger_complete;

const reward = {
  ...score(submitted, oracle(fixture()), events),
  valid_experiment: Number(valid),
};

for (const [name, value] of Object.entries({ reward, metrics, submitted }))
  writeFileSync(`${logs}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);

console.log(JSON.stringify({ reward, metrics }));
