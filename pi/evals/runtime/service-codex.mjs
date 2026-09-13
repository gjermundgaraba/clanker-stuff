#!/usr/bin/env node
import { createRequire } from "node:module";
import { realpathSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { run } from "/opt/codex-provider/codex-runner.mjs";
import { createServices, FIXTURE, SERVICE_NAMES } from "/opt/codex-provider/services.mjs";

const require = createRequire(
  realpathSync("/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/package.json"),
);
const jiti = require("jiti").createJiti("/opt/codex-provider/index.ts");
const { definitions, createJournal } = await jiti.import("/opt/codex-provider/pi-eval-tools.mjs");
const { validateToolArguments } = await jiti.import("@earendil-works/pi-ai");
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
const audit = (event) =>
  appendFileSync("/logs/agent/native-audit.jsonl", `${JSON.stringify(event)}\n`);
const environments = [];
const hooks = {
  threadParams: { environments, dynamicTools, sandbox: "read-only" },
  turnParams: { environments },
  async threadStarted(response) {
    audit({ type: "thread_started", response, dynamicTools, nativeVersion });
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
    if (method !== "item/tool/call" || params.namespace != null)
      throw new Error(`Unexpected native request: ${method}`);
    const definition = tools.find((tool) => tool.name === params.tool);
    if (!definition) throw new Error(`Unknown service: ${params.tool}`);
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
  await run(process.argv[2], hooks);
} catch (error) {
  audit({ type: "runner_error", error: String(error) });
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}
