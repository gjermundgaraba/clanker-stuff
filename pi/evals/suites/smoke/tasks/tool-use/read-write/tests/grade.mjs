import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const answerPath = "/app/answer.txt";

const trajectoryPath = "/logs/agent/trajectory.json";

const answer = existsSync(answerPath) && readFileSync(answerPath, "utf-8") === "CITRINE-47-EMBER\n";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @type {unknown[]} */
let steps = [];

try {
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(trajectoryPath, "utf-8"));
  steps = isRecord(value) && Array.isArray(value.steps) ? value.steps : [];
} catch {}

/** @type {unknown[]} */
const evidence = steps.flatMap(
  /** @returns {unknown[]} */ (step) =>
    isRecord(step) && Array.isArray(step.tool_calls) ? step.tool_calls : [],
);

const calls = evidence.filter(isRecord);

/** @param {Record<string, unknown>} call @param {string} name @param {string} filename */
const targets = (call, name, filename) => {
  const args = call.arguments;

  return (
    call.function_name === name &&
    isRecord(args) &&
    typeof args.path === "string" &&
    path.basename(args.path) === filename
  );
};

const usedRead = calls.some((call) => targets(call, "read", "clue.txt"));

const usedWrite = calls.some((call) => targets(call, "write", "answer.txt"));

const usedForbiddenBash = calls.some(
  (call) =>
    call.function_name === "bash" &&
    /(?:clue|answer)\.txt/u.test(JSON.stringify(call.arguments) ?? ""),
);

const toolContract = usedRead && usedWrite && !usedForbiddenBash;

const quality = Number(answer && toolContract);

writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    answer: Number(answer),
    quality,
    valid_experiment: 1,
    reward: quality,
    tool_contract: Number(toolContract),
  }),
);
