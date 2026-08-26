#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

const schemaPath = process.env.MEM2ACT_SCHEMA_PATH ?? "/app/.mem2act-schema.json";
const callsPath = process.env.MEM2ACT_CALLS_PATH ?? "/app/.mem2act-calls.jsonl";

/** @param {string} text @returns {unknown} */
const parseJson = (text) => /** @type {unknown} */ (JSON.parse(text));

/** @param {unknown} value */
const isObject = (value) => value !== null && !Array.isArray(value) && value === Object(value);

const fail = (message) => {
  console.error(message);
  console.error("usage: mem2act describe | mem2act call --arguments JSON");
  process.exit(2);
};

const [command, ...args] = process.argv.slice(2);
if (command === "describe" && args.length === 0) {
  console.log(JSON.stringify(parseJson(readFileSync(schemaPath, "utf-8"))));
} else if (command === "call" && args.length === 2 && args[0] === "--arguments") {
  const argumentsJson = args[1];
  let parameters = null;
  try {
    parameters = parseJson(argumentsJson);
  } catch {
    fail("--arguments must be valid JSON");
  }
  if (!isObject(parameters)) {
    fail("--arguments must be a JSON object");
  }
  const schema = parseJson(readFileSync(schemaPath, "utf-8"));
  const tool = isObject(schema) && "name" in schema ? schema.name : null;
  if (tool !== String(tool) || tool.length === 0) {
    fail("tool schema must have a name");
  }
  const call = { arguments: parameters, tool };
  appendFileSync(callsPath, `${JSON.stringify(call)}\n`, "utf-8");
  console.log(JSON.stringify(call));
} else {
  fail("invalid invocation");
}
