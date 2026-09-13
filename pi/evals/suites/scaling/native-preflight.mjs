// Real native app-server + Code Mode host, scripted local model: no paid requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as services from "/opt/codex-provider/services.mjs";
const { fixture, SERVICE_NAMES } = services;
const expectedMetrics = JSON.parse(readFileSync("/tests/native-preflight.json", "utf8"));
import { oracle, score, serviceMetrics } from "/tests/scoring.mjs";
import { solve } from "/solution/solve.mjs";

const home = "/tmp/native-preflight-home";
mkdirSync(home, { recursive: true });
mkdirSync("/logs/agent", { recursive: true });
writeFileSync(
  `${home}/config.toml`,
  `model="gpt-6-astra"
model_provider="mock"
model_catalog_json="/preflight/models.json"
model_reasoning_effort="high"
model_auto_compact_token_limit=1000000000
web_search="disabled"
[agents]
enabled=false
[orchestrator.skills]
enabled=false
[orchestrator.mcp]
enabled=false
[features]
goals=false
plugins=false
multi_agent=false
multi_agent_v2=false
sleep_tool=false
default_mode_request_user_input=false
shell_tool=false
view_image=false
[model_providers.mock]
name="mock"
base_url="http://127.0.0.1:41974/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
`,
);
writeFileSync(`${home}/instruction.md`, "Use the service APIs to aggregate the ledger.");
writeFileSync(
  `${home}/run.json`,
  JSON.stringify({
    model: "gpt-6-astra",
    effort: "high",
    instructionPath: `${home}/instruction.md`,
    compactBefore: false,
  }),
);
const requests = [];
const snippets = [
  // Same inputs are checked inside native V8, with actual guessed-call rejection.
  `let invalid; try {invalid=await tools.list_records({collection:"ledger"});} catch(e) {invalid=String(e);} if(!JSON.stringify(invalid).includes("Validation failed"))throw Error("Missing argument-error feedback"); text({invalidArguments:invalid}); const names=ALL_TOOLS.map(t=>t.name).sort(); if(JSON.stringify(names)!==${JSON.stringify(JSON.stringify(["clock__curr_time", ...SERVICE_NAMES].sort((a, b) => a.localeCompare(b))))})throw Error('Unexpected capabilities '+names); text({names,process:typeof process,fetch:typeof fetch}); for(const name of ['exec_command','apply_patch','view_image','read_file']){try{await tools[name]({cmd:'cat /opt/codex-provider/services.mjs',path:'/opt/codex-provider/services.mjs'});throw Error('BYPASS '+name)}catch(e){if(String(e).includes('BYPASS'))throw e;}}`,
  `const solve=${solve.toString()};text(await solve(async(name,args)=>{const r=await tools[name](args);text({native_result_type:typeof r,name});return typeof r==='string'?JSON.parse(r):r}));`,
];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  writeFileSync("/logs/requests.json", JSON.stringify(requests, null, 2));
  const index = requests.length - 1;
  const item =
    index < snippets.length
      ? {
          type: "custom_tool_call",
          call_id: `probe_${index}`,
          name: "exec",
          namespace: "functions",
          input: snippets[index],
        }
      : {
          type: "message",
          id: "done",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done." }],
        };
  const events = [
    { type: "response.created", response: { id: `r${index}` } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `r${index}`,
        status: "completed",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 20,
        },
      },
    },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
});
await new Promise((resolve) => server.listen(41974, "127.0.0.1", resolve));
const child = spawn("codex-eval", [`${home}/run.json`], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "",
  stdout = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 90000);
const code = await new Promise((resolve) => child.on("exit", resolve));
clearTimeout(timeout);
server.close();
writeFileSync("/logs/runner-stderr.log", stderr);
writeFileSync("/logs/runner-stdout.log", stdout);
assert.equal(code, 0, stderr);
const records = stdout.trim().split("\n").map(JSON.parse);
assert.equal(records.length, 3);
assert.ok(records.every((record) => record.type === "eval_event"));
const outputs = requests
  .flatMap((r) => r.input ?? [])
  .filter((item) => item.type === "custom_tool_call_output");
assert.equal(outputs.length >= 2, true);
assert.ok(outputs.every((item) => JSON.stringify(item.output).includes("Script completed")));
assert.ok(!JSON.stringify(outputs).includes("Script error"));
const topTools = requests[0].input
  .filter((i) => i.type === "additional_tools")
  .flatMap((i) => i.tools ?? [])
  .flatMap((t) => t.tools ?? [t])
  .map((t) => t.name)
  .sort();
assert.deepEqual(topTools, ["exec", "request_user_input", "request_user_input_async", "wait"]);
const events = readFileSync("/logs/agent/service-events.jsonl", "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const submission = events.findLast((e) => e.type === "pi_eval_submission")?.report;
assert.equal(
  score(submission, oracle(fixture()), events).quality,
  1,
  "native reference must produce exact report",
);
const metrics = serviceMetrics(events);
for (const [key, expected] of Object.entries(expectedMetrics))
  assert.equal(metrics[key], expected, key);
assert.ok(metrics.ledger_complete);
writeFileSync(
  "/logs/preflight.json",
  JSON.stringify({ metrics, requests: requests.length }, null, 2),
);
console.log("Native API reference and ledger passed using a local scripted model.");
