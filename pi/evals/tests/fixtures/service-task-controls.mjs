import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ default: typeof solve }} SolveModule */

const [task, runtime, logs] = process.argv.slice(2);

assert.ok(
  task !== undefined &&
    task !== "" &&
    runtime !== undefined &&
    runtime !== "" &&
    logs !== undefined &&
    logs !== "",
  "task, runtime and logs paths are required"
);

process.env["EVAL_COMPARISON"] = `${task}/tests/comparison.json`;

const { readComparison } = await import("../../verifiers/comparison.mjs");

const comparison = readComparison();

/** @param {string} file Module path, relative to the working directory. */
const url = (file) => pathToFileURL(path.resolve(file)).href;

/** @param {string} source Self-contained module source; a data: URL resolves no relative imports. */
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const typebox = import.meta.resolve("typebox");

const codingAgent = import.meta.resolve("@earendil-works/pi-coding-agent");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "typebox") {
      return { url: typebox, shortCircuit: true };
    }

    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: codingAgent, shortCircuit: true };
    }

    if (specifier.startsWith("/opt/pi-evals/")) {
      const name = specifier.slice("/opt/pi-evals/".length);

      return {
        url: url(
          name === "eval-journal.mjs"
            ? `${runtime}/${name}`
            : `${task}/environment/${name}`
        ),
        shortCircuit: true,
      };
    }

    return next(specifier, context);
  },
});

// The task generator copies these exact owned modules into a temporary deployment.
/* oxlint-disable typescript/no-unsafe-type-assertion -- Dynamic file URLs name the generator's byte-for-byte copies; reuse their source declarations, not a parallel test interface. */
const { createServices, fixture, SETTINGS, SERVICE_NAMES, FIXTURE } =
  /** @type {typeof import("../../suites/scaling/services.mjs")} */ (
    await import(url(`${task}/environment/services.mjs`))
  );

const { solve } =
  /** @type {typeof import("../../suites/scaling/solve.mjs")} */ (
    await import(url(`${task}/solution/solve.mjs`))
  );

const { definitions } =
  /** @type {typeof import("../../suites/scaling/pi-eval-tools.mjs")} */ (
    await import(url(`${task}/environment/pi-eval-tools.mjs`))
  );

const { score, oracle } =
  /** @type {typeof import("../../suites/scaling/scoring.mjs")} */ (
    await import(url(`${task}/tests/scoring.mjs`))
  );

const { validateNativeDiagnostic } =
  /** @type {typeof import("../../suites/scaling/validity.mjs")} */ (
    await import(url(`${task}/tests/validity.mjs`))
  );
/* oxlint-enable typescript/no-unsafe-type-assertion */

/** @type {import("../../suites/scaling/services.mjs").ServiceEvent[]} */
const backendEvents = [];

const backend = createServices({
  latencyMs: 0,
  emit: (e) => {
    backendEvents.push(e);
  },
});

const defs = definitions(backend);

assert.deepEqual(defs.map((d) => d.name).toSorted(), SERVICE_NAMES);

for (const definition of defs) {
  assert.partialDeepStrictEqual(definition.parameters, { type: "object" });
}

// Same serialized, closure-free function used by real Code Mode preflights.
const serializedSource = data(`export default ${solve.toString()}`);

const { default: serializedSolve } = /** @type {SolveModule} */ (
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This data URL contains only the just-loaded owned solve function; the test verifies it has no undeclared closure dependencies.
  await import(serializedSource)
);

const answer = await serializedSolve(async (name, args) => {
  const definition = defs.find((d) => d.name === name);
  assert.ok(definition, `unknown service ${name}`);
  const result = await definition.execute("test", args);
  const [content] = result.content;
  assert.ok(content);
  /** @type {unknown} */
  const decoded = JSON.parse(content.text);
  // Solve receives the decoded JSON, as through the real tool transport; it must match the typed result.
  assert.deepEqual(decoded, result.structuredContent);

  return decoded;
});

assert.equal(score(answer, oracle(fixture()), backendEvents).quality, 1);

{
  const eventsAtBudget = Array.from({ length: SETTINGS.budget }, () => ({
    type: "pi_eval_service_start",
  }));

  assert.equal(score(answer, oracle(fixture()), eventsAtBudget).quality, 1);
  assert.equal(
    score(answer, oracle(fixture()), [
      ...eventsAtBudget,
      { type: "pi_eval_service_start" },
    ]).quality,
    0
  );
}

process.env["EVAL_LOGS"] = logs;

process.env["EVAL_EVENTS"] = `${logs}/events.jsonl`;

process.env["EVAL_TRAJECTORY"] = `${logs}/trajectory.json`;

for (const arm of ["pi-direct", "pi-code", "native"]) {
  let mode = "native";

  if (arm === "pi-direct") {
    mode = "direct";
  } else if (arm === "pi-code") {
    mode = "code_mode_only";
  }

  const events = [
    {
      type: "pi_eval_diagnostic",
      fixture: FIXTURE,
      mode,
      nestedTools: SERVICE_NAMES,
      latency_ms: 150,
    },
    ...backendEvents,
    ...(arm === "native"
      ? [{ type: "native_finished", nativeVersion: "codex-cli 9.8.7" }]
      : []),
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
          direct_tools: comparison.directTools,
          arm: arm === "pi-direct" ? "direct" : "code",
          tool_mode: mode,
          pair_id: "test",
          platform:
            arm === "pi-direct" ? "pi-without-code-mode" : "pi-with-code-mode",
          compaction_mode: "off",
          expected_mechanism: "pi-builtin",
          expected_protocol: null,
        };

  const evidence = {
    type: "pi_eval_tools",
    valid: true,
    mode,
    activeTools:
      arm === "pi-direct"
        ? [...SERVICE_NAMES]
        : [...SERVICE_NAMES, "codemode"].toSorted(),
    model: comparison.model,
    thinking: comparison.thinking,
  };

  const start = {
    type: "thread_started",
    nativeVersion: "codex-cli 9.8.7",
    response: {
      model: comparison.model.slice(7),
      thread: { environments: /** @type {{cwd: string}[]} */ ([]) },
    },
    dynamicTools: SERVICE_NAMES.map((name) => ({ name })),
  };

  const call = {
    method: "rawResponseItem/completed",
    params: { item: { type: "custom_tool_call", name: "exec" } },
  };

  const trajectory = {
    agent: {
      version: "9.8.7",
      extra: {
        pi_evals: manifest,
        tool_mode_evidence: [evidence],
        native_turn_contexts: [
          { model: comparison.model.slice(7), effort: comparison.thinking },
        ],
        native_diagnostic_audit: [
          start,
          call,
          {
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          },
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

    writeFileSync(
      process.env["EVAL_EVENTS"],
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
    );
    writeFileSync(process.env["EVAL_TRAJECTORY"], JSON.stringify(trajectory));
    await import(`${url(`${task}/tests/grade.mjs`)}?arm=${arm}&valid=${valid}`);
    /** @type {unknown} */
    const reward = JSON.parse(readFileSync(`${logs}/reward.json`, "utf-8"));
    assert.partialDeepStrictEqual(
      reward,
      { quality: 1, valid_experiment: Number(valid) },
      arm
    );
  }

  if (arm === "native") {
    // Restore the catalog after the negative control.
    start.dynamicTools.pop();
    assert.equal(validateNativeDiagnostic(trajectory, events), true);
    start.response.thread.environments = [{ cwd: "/app" }];
    assert.equal(validateNativeDiagnostic(trajectory, events), false);
    start.response.thread.environments = [];
    call.params.item.name = "exec_command";
    assert.equal(validateNativeDiagnostic(trajectory, events), false);
    call.params.item.name = "exec";
    assert.equal(
      validateNativeDiagnostic(
        trajectory,
        events.filter((e) => e.type !== "pi_eval_service_end")
      ),
      false
    );
    // Malformed containers must fail closed, not crash or erase valid task-quality evidence.
    assert.equal(validateNativeDiagnostic(null, events), false);
    assert.equal(
      validateNativeDiagnostic(trajectory, [...events, null]),
      false
    );
  }
}
