#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const runtimeRequire = createRequire("/opt/codex-provider/package.json");
// SAFETY: These are pinned production dependencies resolved from the deployed extension.
const { Type } = /** @type {typeof import("typebox")} */ (runtimeRequire("typebox"));
// SAFETY: These are pinned production dependencies resolved from the deployed extension.
const { Value } = /** @type {typeof import("typebox/value")} */ (runtimeRequire("typebox/value"));

const codingAgentUrl = pathToFileURL(
  "/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
).href;
const compactionTimeoutMs = 4 * 60 * 1000;

const ConfigSchema = Type.Object({
  args: Type.Array(Type.String()),
  cwd: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
});

/**
 * @param {string} text JSON text.
 * @returns {import("typebox").Static<typeof ConfigSchema>} Validated config.
 */
const parseConfig = (text) => {
  try {
    return Value.Parse(ConfigSchema, JSON.parse(text));
  } catch {
    throw new TypeError("invalid Pi compaction config");
  }
};

/** @typedef {{aborted?: boolean, errorMessage?: string, result?: {usage?: unknown}, type: "compaction_end"}} CompactionTerminal */

/** @param {CompactionTerminal} event */
const compactionState = (event) => {
  if (event.aborted !== true && event.aborted !== false) {
    return undefined;
  }
  if (event.aborted) {
    return event.errorMessage === undefined ? "aborted" : undefined;
  }
  if (event.errorMessage) {
    return "failed";
  }
  return event.errorMessage === undefined && event.result?.usage !== undefined
    ? "succeeded"
    : undefined;
};

/**
 * @param {CompactionTerminal[]} terminals
 * @param {Error | undefined} commandError
 * @param {boolean} commandTimedOut
 */
const validateCompaction = (terminals, commandError, commandTimedOut) => {
  const terminal = terminals[0];
  if (terminals.length !== 1 || terminal === undefined) {
    throw commandError ?? new Error("Pi manual compaction did not emit one terminal event");
  }
  const state = compactionState(terminal);
  const commandConsistent =
    state === "succeeded"
      ? commandError === undefined
      : commandTimedOut || commandError !== undefined;
  if (state === undefined || !commandConsistent) {
    throw commandError ?? new Error("Pi manual compaction emitted an invalid terminal event");
  }
  return state;
};

const selfTestCompactionValidation = () => {
  /** @type {CompactionTerminal} */
  const succeeded = { type: "compaction_end", aborted: false, result: { usage: {} } };
  /** @type {CompactionTerminal} */
  const failed = { type: "compaction_end", aborted: false, errorMessage: "failed" };
  /** @type {CompactionTerminal} */
  const aborted = { type: "compaction_end", aborted: true };
  const commandError = new Error("compaction command failed");
  assert.equal(validateCompaction([succeeded], undefined, false), "succeeded");
  assert.equal(validateCompaction([failed], commandError, false), "failed");
  assert.equal(validateCompaction([aborted], commandError, false), "aborted");
  assert.equal(validateCompaction([failed], undefined, true), "failed");
  for (const invalid of [
    () => validateCompaction([], undefined, false),
    () => validateCompaction([succeeded, succeeded], undefined, false),
    () => validateCompaction([{ type: "compaction_end", aborted: false }], undefined, false),
    () => validateCompaction([failed], undefined, false),
    () => validateCompaction([succeeded], commandError, false),
  ]) {
    assert.throws(invalid);
  }
};

/** @returns {Promise<typeof import("@earendil-works/pi-coding-agent").RpcClient>} */
const loadRpcClient = async () => {
  // SAFETY: ESM loaded the pinned pi-coding-agent entry point at the exact deployed path.
  const module = /** @type {typeof import("@earendil-works/pi-coding-agent")} */ (
    await import(codingAgentUrl)
  );
  if (!(module.RpcClient instanceof Function)) {
    throw new TypeError("Pi RPC client is unavailable");
  }
  return module.RpcClient;
};

/** @param {string} configPath */
const run = async (configPath) => {
  const config = parseConfig(await readFile(configPath, "utf-8"));

  const RpcClient = await loadRpcClient();
  /** @type {import("@earendil-works/pi-coding-agent").JsonAgentSessionEvent[]} */
  const events = [];
  const { promise: completionEvent, resolve: resolveCompletion } = Promise.withResolvers();
  const client = new RpcClient({
    args: config.args,
    cliPath: "/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    cwd: config.cwd,
    model: config.model,
    provider: config.provider,
  });
  client.onEvent((event) => {
    events.push(event);
    process.stdout.write(`${JSON.stringify(event)}\n`);
    if (event.type === "compaction_end") {
      resolveCompletion(event);
    }
  });

  await client.start();
  const timeout = setTimeout(() => {
    resolveCompletion(undefined);
  }, compactionTimeoutMs);
  try {
    /** @type {Error | undefined} */
    let commandError;
    let commandTimedOut = false;
    try {
      await client.compact();
    } catch (error) {
      if (error instanceof Error) {
        commandTimedOut = error.message.startsWith("Timeout waiting for response to compact.");
        commandError = commandTimedOut ? undefined : error;
      } else {
        throw error;
      }
    }
    if (commandTimedOut && !events.some((event) => event.type === "compaction_end")) {
      await completionEvent;
    }
    const completed = events.filter((event) => event.type === "compaction_end");
    validateCompaction(completed, commandError, commandTimedOut);
  } finally {
    clearTimeout(timeout);
    await client.stop();
  }
};

if (process.argv[2] === "--self-test") {
  selfTestCompactionValidation();
  await loadRpcClient();
} else {
  const configPath = process.argv[2];
  if (process.argv.length !== 3 || configPath === undefined) {
    throw new Error("usage: pi-eval-compact CONFIG_JSON | pi-eval-compact --self-test");
  }
  await run(configPath);
}
