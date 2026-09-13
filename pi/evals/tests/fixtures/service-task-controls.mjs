import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [task, runtime, logs] = process.argv.slice(2);
const url = (path) => pathToFileURL(resolve(path)).href;
const data = (source) => "data:text/javascript," + encodeURIComponent(source);
const typebox = import.meta.resolve("typebox");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "typebox") return { url: typebox, shortCircuit: true };
    if (specifier === "/opt/codex-provider/registration.ts")
      return { url: data("export function registerCodexProvider() {}"), shortCircuit: true };
    if (specifier === "/opt/codex-provider/code-mode/tools.ts")
      return { url: data("export class CodeModeRuntime {}"), shortCircuit: true };
    if (specifier.startsWith("/opt/codex-provider/")) {
      const name = specifier.slice("/opt/codex-provider/".length);
      return {
        url: url(
          ["service-tools.mjs", "eval-journal.mjs"].includes(name)
            ? `${runtime}/${name}`
            : `${task}/environment/${name}`,
        ),
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
const { createServices, fixture, SETTINGS, SERVICE_NAMES, FIXTURE } = await import(
  url(`${task}/environment/services.mjs`)
);
const { solve } = await import(url(`${task}/solution/solve.mjs`));
const { definitions } = await import(url(`${task}/environment/pi-eval-tools.mjs`));
const { score, oracle } = await import(url(`${task}/tests/scoring.mjs`));
const backendEvents = [];
const backend = createServices({ latencyMs: 0, emit: (e) => backendEvents.push(e) });
const defs = definitions(backend);
assert.deepEqual(defs.map((d) => d.name).sort(), SERVICE_NAMES);
assert.ok(defs.every((d) => d.parameters.type === "object"));
// Same serialized, closure-free function used by real Code Mode preflights.
const { default: serializedSolve } = await import(data(`export default ${solve.toString()}`));
const answer = await serializedSolve(async (name, args) =>
  JSON.parse((await defs.find((d) => d.name === name).execute("test", args)).content[0].text),
);
assert.equal(score(answer, oracle(fixture()), backendEvents).quality, 1);
{
  const eventsAtBudget = Array.from({ length: SETTINGS.budget }, () => ({
    type: "pi_eval_service_start",
  }));
  assert.equal(score(answer, oracle(fixture()), eventsAtBudget).quality, 1);
  assert.equal(score(answer, oracle(fixture()), [...eventsAtBudget, eventsAtBudget[0]]).quality, 0);
}
process.env.EVAL_LOGS = logs;
process.env.EVAL_EVENTS = `${logs}/events.jsonl`;
process.env.EVAL_TRAJECTORY = `${logs}/trajectory.json`;
for (const arm of ["pi-direct", "pi-code", "native"]) {
  const mode = arm === "pi-direct" ? "direct" : arm === "pi-code" ? "code_mode_only" : "native";
  const events = [
    {
      type: "pi_eval_diagnostic",
      fixture: FIXTURE,
      mode,
      nestedTools: SERVICE_NAMES,
      latency_ms: 150,
    },
    ...backendEvents,
    ...(arm === "native" ? [{ type: "native_finished", nativeVersion: "codex-cli 9.8.7" }] : []),
  ];
  const manifest =
    arm === "native"
      ? {
          platform: "codex-native",
          compaction_mode: "off",
          expected_mechanism: "codex-native",
          expected_protocol: null,
        }
      : {
          experiment: "code-mode",
          arm: arm === "pi-direct" ? "direct" : "code",
          tool_mode: mode,
          pair_id: "test",
          platform: "pi-provider",
          compaction_mode: "off",
          expected_mechanism: "codex-provider",
          expected_protocol: "openai-responses-compaction-v2",
        };
  const evidence = {
    type: "pi_eval_tools",
    valid: true,
    mode,
    activeTools: arm === "pi-direct" ? [...SERVICE_NAMES] : ["exec", "wait"],
    model: "openai-codex/gpt-6-astra",
    thinking: "high",
  };
  const start = {
    type: "thread_started",
    nativeVersion: "codex-cli 9.8.7",
    response: { model: "gpt-6-astra", thread: { environments: [] } },
    dynamicTools: SERVICE_NAMES.map((name) => ({ name })),
  };
  const trajectory = {
    agent: {
      version: "9.8.7",
      extra: {
        pi_evals: manifest,
        tool_mode_evidence: [evidence],
        native_turn_contexts: [{ model: "gpt-6-astra", effort: "high" }],
        native_diagnostic_audit: [
          start,
          {
            method: "rawResponseItem/completed",
            params: { item: { type: "custom_tool_call", name: "exec" } },
          },
          { method: "turn/completed", params: { turn: { status: "completed" } } },
        ],
      },
    },
    steps: [{ source: "agent" }],
  };
  for (const valid of [true, false]) {
    if (!valid) {
      evidence.activeTools.push("exec_command");
      start.dynamicTools.push({ name: "exec_command" });
    }
    writeFileSync(process.env.EVAL_EVENTS, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(process.env.EVAL_TRAJECTORY, JSON.stringify(trajectory));
    await import(url(`${task}/tests/grade.mjs`) + `?arm=${arm}&valid=${valid}`);
    const reward = JSON.parse(readFileSync(`${logs}/reward.json`, "utf8"));
    assert.equal(reward.quality, 1);
    assert.equal(reward.valid_experiment, Number(valid), arm);
  }
}

const { validateNativeDiagnostic } = await import(url(`${task}/tests/validity.mjs`));
const native = JSON.parse(readFileSync(process.env.EVAL_TRAJECTORY, "utf8"));
const events = JSON.parse(
  "[" + readFileSync(process.env.EVAL_EVENTS, "utf8").trim().split("\n").join(",") + "]",
);
const audit = native.agent.extra.native_diagnostic_audit;
audit[0].dynamicTools.pop(); // Restore the valid catalog after the negative catalog control.
assert.equal(validateNativeDiagnostic(native, events), true);
audit[0].response.thread.environments = [{ cwd: "/app" }];
assert.equal(validateNativeDiagnostic(native, events), false);
audit[0].response.thread.environments = [];
audit[1].params.item.name = "exec_command";
assert.equal(validateNativeDiagnostic(native, events), false);
audit[1].params.item.name = "exec";
assert.equal(
  validateNativeDiagnostic(
    native,
    events.filter((e) => e.type !== "pi_eval_service_end"),
  ),
  false,
);
