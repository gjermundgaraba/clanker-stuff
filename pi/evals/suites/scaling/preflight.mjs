import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync, writeFileSync } from "node:fs";
import { SETTINGS, createServices, SERVICE_NAMES } from "/opt/codex-provider/services.mjs";
import { oracle, score, serviceMetrics } from "./scoring.mjs";
import { solve } from "/solution/solve.mjs";
const require = createRequire(
  realpathSync("/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/package.json"),
);
const jiti = require("jiti").createJiti("/opt/codex-provider/index.ts");
const { definitions } = await jiti.import("/opt/codex-provider/pi-eval-tools.mjs");
const { CodeModeRuntime } = await jiti.import("/opt/codex-provider/code-mode/tools.ts");
// Positive validity controls must cover both Pi catalogs, not only missing evidence.
const { validateToolMode } = await import("./tool-mode.mjs");
for (const arm of ["direct", "code"]) {
  const mode = arm === "direct" ? "direct" : "code_mode_only";
  const names = arm === "direct" ? SERVICE_NAMES : ["exec", "wait"];
  const t = {
    agent: {
      extra: {
        pi_evals: {
          experiment: "code-mode",
          arm,
          tool_mode: mode,
          pair_id: "preflight",
          platform: "pi-provider",
          compaction_mode: "off",
          expected_mechanism: "codex-provider",
          expected_protocol: "openai-responses-compaction-v2",
        },
        tool_mode_evidence: [
          {
            type: "pi_eval_tools",
            mode,
            activeTools: names,
            valid: true,
            model: "openai-codex/gpt-6-astra",
            thinking: "high",
          },
        ],
      },
    },
    steps: [],
  };
  assert.equal(validateToolMode(t).valid_experiment, 1);
  t.agent.extra.tool_mode_evidence[0].activeTools = ["exec_command"];
  assert.equal(validateToolMode(t).valid_experiment, 0);
}
const summaries = {};
for (const mode of ["direct", "code"]) {
  const events = [],
    backend = createServices({ emit: (e) => events.push(e), latencyMs: 0 }),
    defs = definitions(backend);
  if (mode === "direct")
    await solve(async (name, args) =>
      JSON.parse((await defs.find((d) => d.name === name).execute("test", args)).content[0].text),
    );
  else {
    const runtime = new CodeModeRuntime();
    runtime.setNestedTools(defs.map((definition) => ({ definition, outputSchema: {} })));
    const exec = runtime.createTools().find((t) => t.name === "exec");
    try {
      const r = await exec.execute(
        "test",
        {
          code: `try {await tools.list_records({collection:"ledger"}); throw Error("malformed call accepted");} catch(e) {if(!String(e).includes("Validation failed"))throw e;} if(typeof process!=='undefined'||typeof fetch!=='undefined'||typeof tools.exec_command!=='undefined')throw Error('capability leak'); if(JSON.stringify(ALL_TOOLS.map(t=>t.name).sort())!==${JSON.stringify(JSON.stringify(SERVICE_NAMES))})throw Error('unexpected tools'); const solve=${solve.toString()}; text(await solve((name,args)=>tools[name](args)));`,
        },
        new AbortController().signal,
        undefined,
        {},
      );
      assert.equal(r.details.scriptError, undefined, JSON.stringify(r));
      const denied = await exec.execute(
        "denied",
        { code: 'await tools.exec_command({cmd:"cat /opt/codex-provider/services.mjs"})' },
        new AbortController().signal,
        undefined,
        {},
      );
      assert.ok(denied.details.scriptError);
    } finally {
      await runtime.shutdown();
    }
  }
  const answer = events.findLast((e) => e.type === "pi_eval_submission").report;
  assert.equal(score(answer, oracle(), events).quality, 1);
  assert.equal(score(null, oracle(), events).quality, 0);
  assert.equal(score({}, oracle(), events).quality, 0);
  const eventPath = `/logs/${mode}-events.jsonl`;
  writeFileSync(eventPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const gradeLogs = `/logs/${mode}-grade`;
  const graded = JSON.parse(
    execFileSync("node", ["/tests/grade.mjs"], {
      encoding: "utf8",
      env: { ...process.env, EVAL_EVENTS: eventPath, EVAL_LOGS: gradeLogs },
    }),
  );
  assert.equal(graded.reward.quality, 1);
  assert.equal(graded.reward.valid_experiment, 0);
  summaries[mode] = serviceMetrics(events);
  assert.equal(summaries[mode].ledger_complete, true);
  assert.ok(score({ ...answer, rows: answer.rows.slice(1) }, oracle(), events).row_accuracy < 1);
  assert.equal(
    score({ ...answer, total_cents: answer.total_cents + 1 }, oracle(), events).quality,
    0,
  );
  const over = [
    ...events,
    ...Array.from({ length: SETTINGS.budget + 1 }, () => ({ type: "pi_eval_service_start" })),
  ];
  assert.equal(score(answer, oracle(), over).quality, 0);
}

assert.equal(summaries.direct.response_bytes, summaries.code.response_bytes);
writeFileSync("/logs/preflight.json", JSON.stringify(summaries, null, 2));
console.log(
  "Ledger reference, negative scoring, budget controls, and real Pi Code Mode parity passed.",
);
