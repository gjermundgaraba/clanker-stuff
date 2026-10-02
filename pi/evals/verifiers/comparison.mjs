import { readFileSync } from "node:fs";

/** Read the frozen expectations packaged with the task, never infer them from observed execution. */
export function readComparison(path = process.env.EVAL_COMPARISON ?? "/tests/comparison.json") {
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(path, "utf8"));

  if (
    typeof value !== "object" ||
    value === null ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    !value.model.startsWith("openai/") ||
    !value.model.slice(7).trim() ||
    !("thinking" in value) ||
    typeof value.thinking !== "string" ||
    !value.thinking.trim() ||
    !("directTools" in value) ||
    !Array.isArray(value.directTools) ||
    value.directTools.length === 0
  )
    throw new Error("Invalid frozen comparison expectations");

  const names = value.directTools.filter((name) => typeof name === "string");

  if (
    names.length !== value.directTools.length ||
    names.some((name) => !name.trim() || name === "codemode") ||
    new Set(names).size !== names.length
  )
    throw new Error("Invalid frozen tool inventory");

  return {
    model: value.model,
    thinking: value.thinking,
    directTools: names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}
