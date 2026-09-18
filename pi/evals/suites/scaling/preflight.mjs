import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync, writeFileSync } from "node:fs";
import { SETTINGS, createServices, SERVICE_NAMES } from "/opt/codex-provider/services.mjs";
import { isRecord } from "./service-metrics.mjs";
import { oracle, score, serviceMetrics } from "./scoring.mjs";
import { solve } from "/solution/solve.mjs";

const require = createRequire(
  realpathSync("/opt/codex-provider/node_modules/@earendil-works/pi-coding-agent/package.json"),
);

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createRequire resolves the pinned Jiti dependency from the deployed Pi package, not arbitrary user modules.
const { createJiti } = /** @type {typeof import("jiti")} */ (require("jiti"));

const jiti = createJiti("/opt/codex-provider/index.ts");

// The frozen image deploys this exact owned module/dependency; give the dynamic loader its source declarations.
const { definitions } = /** @type {typeof import("/opt/codex-provider/pi-eval-tools.mjs")} */ (
  await jiti.import("/opt/codex-provider/pi-eval-tools.mjs")
);

// The frozen image deploys this exact owned module/dependency; give the dynamic loader its source declarations.
const { CodeModeRuntime } = /** @type {typeof import("/opt/codex-provider/code-mode/tools.ts")} */ (
  await jiti.import("/opt/codex-provider/code-mode/tools.ts")
);

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

  for (const evidence of t.agent.extra.tool_mode_evidence) evidence.activeTools = ["exec_command"];
  assert.equal(validateToolMode(t).valid_experiment, 0);
}

/** @type {Map<string, ReturnType<typeof serviceMetrics>>} */
const summaries = new Map();

for (const mode of ["direct", "code"]) {
  /** @type {import("./services.mjs").ServiceEvent[]} */
  const events = [];

  const backend = createServices({
    emit: (e) => {
      events.push(e);
    },
    latencyMs: 0,
  });

  const defs = definitions(backend);

  if (mode === "direct")
    await solve(async (name, args) => {
      const definition = defs.find((d) => d.name === name);
      assert.ok(definition, `unknown service ${name}`);
      const [content] = (await definition.execute("test", args)).content;
      assert.ok(content);

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This owned definition JSON-encodes its backend's JSON-only ServiceResult; test the real tool transport instead of bypassing it.
      return /** @type {import("./services.mjs").ServiceResult} */ (JSON.parse(content.text));
    });
  else {
    const runtime = new CodeModeRuntime();
    runtime.setNestedTools(defs.map((definition) => ({ definition, outputSchema: {} })));
    const exec = runtime.createTools().find((t) => t.name === "exec");
    assert.ok(exec);

    const context = /** @type {import("@earendil-works/pi-coding-agent").ExtensionContext} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These isolated service tools require no Pi session. Fail on every context access so a future dependency cannot silently pass this standalone runtime preflight.
      new Proxy(
        {},
        {
          get(_target, key) {
            throw new Error(`Unexpected Pi context access: ${String(key)}`);
          },
        },
      )
    );

    try {
      const r = await exec.execute(
        "test",
        {
          code: `try {await tools.list_records({collection:"ledger"}); throw Error("malformed call accepted");} catch(e) {if(!String(e).includes("Validation failed"))throw e;} if(typeof process!=='undefined'||typeof fetch!=='undefined'||typeof tools.exec_command!=='undefined')throw Error('capability leak'); if(JSON.stringify(ALL_TOOLS.map(t=>t.name).sort())!==${JSON.stringify(JSON.stringify(SERVICE_NAMES))})throw Error('unexpected tools'); const solve=${solve.toString()}; text(await solve((name,args)=>tools[name](args)));`,
        },
        new AbortController().signal,
        undefined,
        context,
      );

      assert.ok(isRecord(r.details));
      assert.equal(r.details.scriptError, undefined, JSON.stringify(r));

      const denied = await exec.execute(
        "denied",
        { code: 'await tools.exec_command({cmd:"cat /opt/codex-provider/services.mjs"})' },
        new AbortController().signal,
        undefined,
        context,
      );

      assert.ok(isRecord(denied.details) && denied.details.scriptError);
    } finally {
      await runtime.shutdown();
    }
  }

  const answer = events.findLast((e) => e.type === "pi_eval_submission")?.report;
  assert.deepEqual(answer, oracle());
  assert.equal(score(answer, oracle(), events).quality, 1);
  assert.equal(score(null, oracle(), events).quality, 0);
  assert.equal(score({}, oracle(), events).quality, 0);
  const eventPath = `/logs/${mode}-events.jsonl`;
  writeFileSync(eventPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const gradeLogs = `/logs/${mode}-grade`;

  /** @type {unknown} */
  const graded = JSON.parse(
    execFileSync("node", ["/tests/grade.mjs"], {
      encoding: "utf8",
      env: { ...process.env, EVAL_EVENTS: eventPath, EVAL_LOGS: gradeLogs },
    }),
  );

  assert.partialDeepStrictEqual(graded, { reward: { quality: 1, valid_experiment: 0 } });
  const metrics = serviceMetrics(events);
  summaries.set(mode, metrics);
  assert.equal(metrics.ledger_complete, true);
  const expected = oracle();
  assert.ok(
    score({ ...expected, rows: expected.rows.slice(1) }, expected, events).row_accuracy < 1,
  );
  assert.equal(
    score({ ...expected, total_cents: expected.total_cents + 1 }, expected, events).quality,
    0,
  );

  const over = [
    ...events,
    ...Array.from({ length: SETTINGS.budget + 1 }, () => ({ type: "pi_eval_service_start" })),
  ];

  assert.equal(score(answer, oracle(), over).quality, 0);
}

const direct = summaries.get("direct"),
  code = summaries.get("code");

assert.ok(direct && code);

assert.equal(direct.response_bytes, code.response_bytes);

writeFileSync("/logs/preflight.json", JSON.stringify(Object.fromEntries(summaries), null, 2));

console.log(
  "Ledger reference, negative scoring, budget controls, and real Pi Code Mode parity passed.",
);
