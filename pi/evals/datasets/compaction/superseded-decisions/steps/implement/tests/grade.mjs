import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

let planDeployment = () => {
  throw new Error("deployment module did not load");
};
try {
  ({ planDeployment } = await import("/app/src/deployment.js"));
} catch {}

const tests = spawnSync(
  "node",
  ["--test", "/app/test/deployment.test.js", "/tests/hidden.test.js"],
  { encoding: "utf-8" }
);
writeFileSync("/logs/verifier/tests.tap", `${tests.stdout}${tests.stderr}`);

let trajectory = {};
try {
  trajectory = JSON.parse(readFileSync("/logs/agent/trajectory.json", "utf-8"));
} catch {}
const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
const policies = {
  "codex-cli-off": {
    compactionExpected: false,
    mechanism: "codex-cli",
  },
  "codex-cli-on": { compactionExpected: true, mechanism: "codex-cli" },
  "pi-provider-off": {
    compactionExpected: false,
    mechanism: "codex-provider",
  },
  "pi-provider-on": {
    compactionExpected: true,
    mechanism: "codex-provider",
  },
  "pi-vanilla-off": {
    compactionExpected: false,
    mechanism: "pi-builtin",
  },
  "pi-vanilla-on": { compactionExpected: true, mechanism: "pi-builtin" },
};
const oracle = trajectory.agent?.name === "oracle";
const policy = oracle
  ? { compactionExpected: true, mechanism: "oracle" }
  : policies[trajectory.agent?.name];
const compactionAttempts = steps
  .map((step, index) => ({ index, extra: step.extra }))
  .filter(({ extra }) => extra?.event_type === "context_compaction");
const compactions = compactionAttempts.filter(
  ({ extra }) => extra.state === "succeeded"
);
const firstBoundary = compactions.find(
  ({ extra }) => extra.segment >= 2 && extra.segment <= 4
);
const secondBoundary = compactions.find(
  ({ extra }) => extra.segment >= 7 && extra.segment <= 9
);
const boundary = Boolean(firstBoundary && secondBoundary);
const mechanism =
  oracle ||
  (policy?.compactionExpected === false
    ? compactionAttempts.length === 0
    : compactions.length > 0 &&
      compactions.every(
        ({ extra }) =>
          extra.mechanism === policy?.mechanism &&
          (policy?.mechanism !== "codex-provider" ||
            extra.protocol === "openai-responses-compaction-v2")
      ));
const finalInstructionIndex = steps.findLastIndex(
  (step) => step.source === "user"
);
const continued = steps.some(
  (step, index) => index > finalInstructionIndex && step.source === "agent"
);
const valid =
  Boolean(policy) &&
  (policy.compactionExpected
    ? boundary &&
      compactionAttempts.length > 0 &&
      compactions.length === compactionAttempts.length &&
      mechanism &&
      continued
    : compactionAttempts.length === 0 && continued);

const probe = (fn) => {
  try {
    return Number(fn());
  } catch {
    return 0;
  }
};
const base = { regions: [], service: "api", target: "prod" };
const facts = {
  attempts_current: probe(() => {
    const defaults = planDeployment(base).attempts === 4;
    let rejects = true;
    for (const attempts of [-1, 6, 1.5, "2"]) {
      try {
        planDeployment({ ...base, attempts });
        rejects = false;
      } catch (error) {
        rejects &&= error instanceof TypeError;
      }
    }
    return defaults && rejects;
  }),
  regions_early: probe(
    () =>
      JSON.stringify(
        planDeployment({
          ...base,
          regions: ["APAC", " us ", "apac", "eu"],
        }).regions
      ) === JSON.stringify(["us", "eu", "apac"])
  ),
  service_early: probe(() => {
    const normalized = planDeployment({ ...base, service: " API " }).service;
    let rejected = false;
    try {
      planDeployment({ ...base, service: " " });
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    return normalized === "api" && rejected;
  }),
  shape: probe(
    () =>
      JSON.stringify(
        Object.keys(planDeployment({ ...base, ignored: true })).sort()
      ) === JSON.stringify(["attempts", "regions", "service", "target"].sort())
  ),
  target_current: probe(() => {
    const result = planDeployment({ ...base, target: " PROD " });
    return result.target === "prod" && !("destination" in result);
  }),
};
const quality = Object.values(facts).reduce((sum, value) => sum + value, 0) / 5;
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    ...facts,
    compaction_boundaries: Number(boundary),
    compaction_count: compactions.length,
    continuation: Number(continued),
    mechanism: Number(mechanism),
    quality,
    reward: valid ? quality : 0,
    tests: Number(tests.status === 0),
    valid_experiment: Number(valid),
  })
);
