#!/usr/bin/env node
import { Type } from "typebox";
import { Value } from "typebox/value";
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { run } from "/opt/pi-evals/codex-runner.mjs";
import { createServices, FIXTURE, SERVICE_NAMES } from "/opt/pi-evals/services.mjs";

import { definitions, createJournal } from "/opt/pi-evals/pi-eval-tools.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai";

const journal = createJournal("/logs/agent/service-events.jsonl");

await journal.reset();

const tools = definitions(createServices({ emit: journal.emit }));

const dynamicTools = tools.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description.replace(
    "Code Mode receives a parsed object.",
    "Native Code Mode receives a JSON string; parse it with JSON.parse.",
  ),
  inputSchema: tool.parameters,
}));

const nativeVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();

/** @param {unknown} event Persist native protocol evidence verbatim; its grader owns interpretation. */
const audit = (event) =>
  appendFileSync("/logs/agent/native-audit.jsonl", `${JSON.stringify(event)}\n`);

/** @type {never[]} */
const environments = [];

const StartedSchema = Type.Object({
  model: Type.String(),
  thread: Type.Object({ environments: Type.Array(Type.Unknown()) }),
});

// Recursive JSON validation matches the public SDK JsonValue contract, not a Code Mode protocol.
/** @type {import("typebox").TUnsafe<import("@earendil-works/pi-ai").JsonValue>} */
const JsonValueSchema = Type.Unsafe({
  $defs: {
    value: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/value" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/value" } },
      ],
    },
  },
  $ref: "#/$defs/value",
});

const ToolCallSchema = Type.Object({
  namespace: Type.Optional(Type.Null()),
  tool: Type.String(),
  callId: Type.String(),
  arguments: Type.Record(Type.String(), JsonValueSchema),
});

/** @type {import("./codex-eval.mjs").RunnerHooks} */
const hooks = {
  threadParams: { environments, dynamicTools, sandbox: "read-only" },
  turnParams: { environments },
  async threadStarted(response, config) {
    audit({ type: "thread_started", response, dynamicTools, nativeVersion });

    if (!Value.Check(StartedSchema, response))
      throw new TypeError("Invalid native thread/start response");

    if (response.model !== config.model || JSON.stringify(response.thread.environments) !== "[]")
      throw new Error("Native model/environment isolation mismatch");
    await journal.emit({
      type: "pi_eval_diagnostic",
      fixture: FIXTURE,
      mode: "native",
      nestedTools: SERVICE_NAMES,
      latency_ms: 150,
      nativeVersion,
    });
  },
  async request(method, params) {
    if (method !== "item/tool/call") throw new Error(`Unexpected native request: ${method}`);

    // A malformed tool call is recoverable model feedback, not a transport failure.
    if (!Value.Check(ToolCallSchema, params)) {
      return {
        success: false,
        contentItems: [
          { type: "inputText", text: "Validation failed: invalid native tool-call envelope" },
        ],
      };
    }

    const definition = tools.find((tool) => tool.name === params.tool);

    if (!definition) throw new Error(`Unknown service: ${params.tool}`);
    /** @type {unknown} */
    let args;

    try {
      args = validateToolArguments(definition, {
        type: "toolCall",
        name: params.tool,
        id: params.callId,
        arguments: params.arguments,
      });
    } catch (error) {
      return { success: false, contentItems: [{ type: "inputText", text: String(error) }] };
    }

    const result = await definition.execute(params.callId, args, new AbortController().signal);

    return {
      success: true,
      contentItems: result.content.map((item) => ({ type: "inputText", text: item.text })),
    };
  },
  notification(message) {
    if (
      message.method !== undefined &&
      ["rawResponseItem/completed", "rawResponse/completed", "turn/completed", "error"].includes(
        message.method,
      )
    )
      audit(message);
  },
  async finished() {
    await journal.emit({ type: "native_finished", nativeVersion });
  },
};

try {
  const config = process.argv[2];

  if (!config) throw new Error("usage: service-codex CONFIG_JSON");
  await run(config, hooks);
} catch (error) {
  audit({ type: "runner_error", error: String(error) });
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
}
