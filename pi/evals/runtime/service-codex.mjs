#!/usr/bin/env node
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createRequire } from "node:module";
import { realpathSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { run } from "/opt/codex-provider/codex-runner.mjs";
import { createServices, FIXTURE, SERVICE_NAMES } from "/opt/codex-provider/services.mjs";

const require = createRequire(
  realpathSync("/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/package.json"),
);

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createRequire resolves the pinned Jiti dependency from the deployed Pi package, not arbitrary user modules.
const { createJiti } = /** @type {typeof import("jiti")} */ (require("jiti"));

const jiti = createJiti("/opt/codex-provider/index.ts");

// The frozen image deploys this exact owned module/dependency; give the dynamic loader its source declarations.
const { definitions, createJournal } =
  /** @type {typeof import("/opt/codex-provider/pi-eval-tools.mjs")} */ (
    await jiti.import("/opt/codex-provider/pi-eval-tools.mjs")
  );

// The frozen image deploys this exact owned module/dependency; give the dynamic loader its source declarations.
const { validateToolArguments } = /** @type {typeof import("@earendil-works/pi-ai")} */ (
  await jiti.import("@earendil-works/pi-ai")
);

// Native tool calls carry JSON-only arguments; the provider owns that boundary's schema.
const { JsonObjectSchema } =
  /** @type {typeof import("/opt/codex-provider/code-mode/protocol.ts")} */ (
    await jiti.import("/opt/codex-provider/code-mode/protocol.ts")
  );

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

const ToolCallSchema = Type.Object({
  namespace: Type.Optional(Type.Null()),
  tool: Type.String(),
  callId: Type.String(),
  arguments: JsonObjectSchema,
});

/** @type {import("./codex-eval.mjs").RunnerHooks} */
const hooks = {
  threadParams: { environments, dynamicTools, sandbox: "read-only" },
  turnParams: { environments },
  async threadStarted(response) {
    audit({ type: "thread_started", response, dynamicTools, nativeVersion });

    if (!Value.Check(StartedSchema, response))
      throw new TypeError("Invalid native thread/start response");

    if (response.model !== "gpt-6-astra" || JSON.stringify(response.thread.environments) !== "[]")
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
