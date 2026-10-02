import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { SETTINGS, createServices, SERVICE_NAMES } from "/opt/pi-evals/services.mjs";
import { oracle, score, serviceMetrics } from "/tests/scoring.mjs";
import { solve } from "/solution/solve.mjs";

import { definitions } from "/opt/pi-evals/pi-eval-tools.mjs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { validateToolMode } from "/tests/tool-mode.mjs";
import { readComparison } from "/tests/comparison.mjs";

const comparison = readComparison();

for (const arm of ["direct", "code"]) {
  const mode = arm === "direct" ? "direct" : "code_mode_only";
  const names = arm === "direct" ? SERVICE_NAMES : [...SERVICE_NAMES, "codemode"].sort();

  const t = {
    agent: {
      extra: {
        pi_evals: {
          experiment: "code-mode",
          direct_tools: comparison.directTools,
          arm,
          tool_mode: mode,
          pair_id: "preflight",
          platform: arm === "direct" ? "pi-without-code-mode" : "pi-with-code-mode",
          compaction_mode: "off",
          expected_mechanism: "pi-builtin",
          expected_protocol: null,
        },
        tool_mode_evidence: [
          {
            type: "pi_eval_tools",
            mode,
            activeTools: names,
            valid: true,
            model: comparison.model,
            thinking: comparison.thinking,
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
    const settingsManager = SettingsManager.inMemory();

    const resourceLoader = new DefaultResourceLoader({
      cwd: "/tmp",
      agentDir: "/tmp/scaling-preflight",
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      extensionFactories: [
        createCodemodeExtension({ mode: "only", models: false }),
        (pi) => {
          for (const definition of defs) pi.registerTool(definition);
        },
      ],
    });

    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: "/tmp",
      agentDir: "/tmp/scaling-preflight",
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory("/tmp"),
      tools: [...SERVICE_NAMES, "codemode"],
    });

    await session.bindExtensions({});
    session.agent.state.messages = [
      ...session.agent.state.messages,
      fauxAssistantMessage(fauxToolCall("codemode", { code: "preflight" }, { id: "preflight" }), {
        stopReason: "toolUse",
      }),
    ];
    const context = session.extensionRunner.createToolContext("preflight", undefined);
    const codemode = session.getToolDefinition("codemode");
    assert.ok(codemode);

    try {
      const result = await codemode.execute(
        "preflight",
        {
          code: `try {await tools.list_records({collection:"ledger"}); throw Error("malformed call accepted");} catch(e) {if(!String(e).includes("Validation failed"))throw e;} if(typeof process!=='undefined'||typeof fetch!=='undefined'||'exec_command' in tools)throw Error('capability leak'); if(JSON.stringify(ALL_TOOLS.map(t=>t.name).sort())!==${JSON.stringify(JSON.stringify(SERVICE_NAMES))})throw Error('unexpected tools'); const solve=${solve.toString()}; text(await solve((name,args)=>tools[name](args)));`,
        },
        new AbortController().signal,
        undefined,
        context,
      );

      assert.notEqual(result.isError, true, JSON.stringify(result));

      const denied = await codemode.execute(
        "preflight",
        { code: 'await tools.exec_command({cmd:"cat /opt/pi-evals/services.mjs"})' },
        new AbortController().signal,
        undefined,
        context,
      );

      assert.equal(denied.isError, true);
    } finally {
      session.dispose();
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
