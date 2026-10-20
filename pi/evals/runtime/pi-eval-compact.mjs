#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

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

// Pi emits a present undefined result on failed/aborted compaction; malformed/missing terminal fields remain testable.
/** @typedef {{aborted?: boolean, errorMessage?: string, result?: {usage?: unknown}|undefined, type: "compaction_end"}} CompactionTerminal */

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
export const validateCompaction = (terminals, commandError, commandTimedOut) => {
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

/** @param {string} configPath */
const run = async (configPath) => {
  const config = parseConfig(await readFile(configPath, "utf-8"));

  /** @type {import("@earendil-works/pi-coding-agent").JsonAgentSessionEvent[]} */
  const events = [];
  const { promise: completionEvent, resolve: resolveCompletion } = Promise.withResolvers();

  const client = new RpcClient({
    args: config.args,
    cliPath: "/opt/pi-evals/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const configPath = process.argv[2];

  if (process.argv.length !== 3 || configPath === undefined) {
    throw new Error("usage: pi-eval-compact CONFIG_JSON | pi-eval-compact --self-test");
  }

  // The self-test only proves that this entry point and its deployed dependencies load.
  if (configPath !== "--self-test") {
    await run(configPath);
  }
}
