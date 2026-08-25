#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const runtimeRequire = createRequire("/opt/codex-provider/package.json");
/** @type {unknown} */
const rawTypebox = runtimeRequire("typebox");
/** @type {unknown} */
const rawValue = runtimeRequire("typebox/value");
// SAFETY: These are pinned production dependencies resolved from the deployed extension.
const { Type } = /** @type {typeof import("typebox")} */ (rawTypebox);
// SAFETY: These are pinned production dependencies resolved from the deployed extension.
const { Value } = /** @type {typeof import("typebox/value")} */ (rawValue);

const codingAgentUrl = pathToFileURL(
  "/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
).href;

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

/** @returns {Promise<typeof import("@earendil-works/pi-coding-agent").RpcClient>} */
const loadRpcClient = async () => {
  /** @type {unknown} */
  const rawModule = await import(codingAgentUrl);
  // SAFETY: ESM loaded the pinned pi-coding-agent entry point at the exact deployed path.
  const module = /** @type {typeof import("@earendil-works/pi-coding-agent")} */ (rawModule);
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
  const client = new RpcClient({
    args: config.args,
    cliPath: "/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    cwd: config.cwd,
    model: config.model,
    provider: config.provider,
  });
  client.onEvent((event) => {
    events.push(event);
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });

  await client.start();
  try {
    const result = await client.compact();
    const completed = events.filter((event) => event.type === "compaction_end");
    const completion = completed[0];
    if (
      completed.length !== 1 ||
      completion === undefined ||
      completion.aborted ||
      completion.errorMessage !== undefined ||
      result.usage === undefined
    ) {
      throw new Error("Pi manual compaction did not complete with usage");
    }
  } finally {
    await client.stop();
  }
};

if (process.argv[2] === "--self-test") {
  await loadRpcClient();
} else {
  const configPath = process.argv[2];
  if (process.argv.length !== 3 || configPath === undefined) {
    throw new Error("usage: pi-eval-compact CONFIG_JSON | pi-eval-compact --self-test");
  }
  await run(configPath);
}
