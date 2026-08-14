import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const answerPath = "/app/answer.txt";
const trajectoryPath = "/logs/agent/trajectory.json";
const answer =
  existsSync(answerPath) &&
  readFileSync(answerPath, "utf-8") === "CITRINE-47-EMBER\n";
let steps = [];
try {
  const value = JSON.parse(readFileSync(trajectoryPath, "utf-8"));
  steps = Array.isArray(value.steps) ? value.steps : [];
} catch {}
const calls = steps.flatMap((step) => step.tool_calls ?? []);
const targets = (call, name, filename) =>
  call.function_name === name &&
  path.basename(String(call.arguments?.path ?? "")) === filename;
const usedRead = calls.some((call) => targets(call, "read", "clue.txt"));
const usedWrite = calls.some((call) => targets(call, "write", "answer.txt"));
const usedForbiddenBash = calls.some(
  (call) =>
    call.function_name === "bash" &&
    /(?:clue|answer)\.txt/u.test(JSON.stringify(call.arguments))
);
const toolContract = usedRead && usedWrite && !usedForbiddenBash;
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    answer: Number(answer),
    reward: Number(answer && toolContract),
    tool_contract: Number(toolContract),
  })
);
