#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

const schemaPath =
  process.env.MEM2ACT_SCHEMA_PATH ?? "/app/.mem2act-schema.json";
const callsPath = process.env.MEM2ACT_CALLS_PATH ?? "/app/.mem2act-calls.jsonl";

/**
 * @param {string} text JSON text.
 * @returns {unknown} Parsed value.
 */
const parseJson = (text) => {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  return parsed;
};

const fail = (message) => {
  console.error(message);
  console.error(
    "usage: mem2act describe | mem2act call --tool NAME --arguments JSON"
  );
  process.exit(2);
};

const [command, ...args] = process.argv.slice(2);
if (command === "describe" && args.length === 0) {
  console.log(JSON.stringify(parseJson(readFileSync(schemaPath, "utf-8"))));
} else if (command === "call") {
  let tool;
  let argumentsJson;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--tool", "--arguments"].includes(flag) || value === undefined) {
      fail(`invalid argument: ${flag ?? "<missing>"}`);
    }
    if (flag === "--tool") {
      if (tool !== undefined) {
        fail(`duplicate argument: ${flag}`);
      }
      tool = value;
    } else {
      if (argumentsJson !== undefined) {
        fail(`duplicate argument: ${flag}`);
      }
      argumentsJson = value;
    }
  }
  if (tool === undefined || tool.length === 0 || argumentsJson === undefined) {
    fail("--tool and --arguments are required");
  }
  let parameters = null;
  try {
    parameters = parseJson(argumentsJson);
  } catch {
    fail("--arguments must be valid JSON");
  }
  if (
    parameters === null ||
    Array.isArray(parameters) ||
    typeof parameters !== "object"
  ) {
    fail("--arguments must be a JSON object");
  }
  const call = { arguments: parameters, tool };
  appendFileSync(callsPath, `${JSON.stringify(call)}\n`, "utf-8");
  console.log(JSON.stringify(call));
} else {
  fail(`unknown command: ${command ?? "<missing>"}`);
}
