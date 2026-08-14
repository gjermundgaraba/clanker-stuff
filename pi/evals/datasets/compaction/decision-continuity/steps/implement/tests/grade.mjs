import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

let normalizeRelease = () => {
  throw new Error("release module did not load");
};
try {
  ({ normalizeRelease } = await import("/app/src/release.js"));
} catch {}

const tests = spawnSync(
  "node",
  ["--test", "/app/test/release.test.js", "/tests/hidden.test.js"],
  { encoding: "utf-8" }
);
writeFileSync("/logs/verifier/tests.tap", `${tests.stdout}${tests.stderr}`);
const trajectoryPath = "/logs/agent/trajectory.json";
let trajectory = {};
try {
  trajectory = JSON.parse(readFileSync(trajectoryPath, "utf-8"));
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
const compactionIndex = steps.findIndex(
  (step) =>
    step.extra?.event_type === "context_compaction" &&
    step.extra?.state === "succeeded" &&
    step.extra?.segment >= 5 &&
    step.extra?.segment <= 7
);
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
    ? compactionIndex >= 0 &&
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
const facts = {
  artifacts: probe(
    () =>
      JSON.stringify(
        normalizeRelease({
          artifacts: [" App.zip ", "app.ZIP", "", "symbols.tgz"],
          channel: "stable",
          regions: [],
        }).artifacts
      ) === JSON.stringify(["App.zip", "symbols.tgz"])
  ),
  channel: probe(() => {
    const normalized = normalizeRelease({
      artifacts: [],
      channel: " BETA ",
      regions: [],
    }).channel;
    let rejected = false;
    try {
      normalizeRelease({ artifacts: [], channel: "edge", regions: [] });
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    return normalized === "beta" && rejected;
  }),
  regions: probe(
    () =>
      JSON.stringify(
        normalizeRelease({
          artifacts: [],
          channel: "stable",
          regions: ["APAC", " us ", "eu"],
        }).regions
      ) === JSON.stringify(["us", "eu", "apac"])
  ),
  rollout: probe(() => {
    const base = { artifacts: [], channel: "stable", regions: [] };
    const defaults = normalizeRelease(base).rolloutPercent === 100;
    const coerces =
      normalizeRelease({ ...base, rolloutPercent: "25" }).rolloutPercent === 25;
    let rejects = true;
    for (const value of [-1, 101, 1.5, "nope"]) {
      try {
        normalizeRelease({ ...base, rolloutPercent: value });
        rejects = false;
      } catch (error) {
        rejects &&= error instanceof TypeError;
      }
    }
    return defaults && coerces && rejects;
  }),
  shape: probe(
    () =>
      JSON.stringify(
        Object.keys(
          normalizeRelease({
            artifacts: [],
            channel: "stable",
            ignored: true,
            regions: [],
          })
        ).sort()
      ) ===
      JSON.stringify(
        ["artifacts", "channel", "regions", "rolloutPercent"].sort()
      )
  ),
};
const quality = Object.values(facts).reduce((sum, value) => sum + value, 0) / 5;
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    ...facts,
    compaction_boundary: Number(compactionIndex >= 0),
    compaction_count: compactions.length,
    continuation: Number(continued),
    mechanism: Number(mechanism),
    quality,
    reward: valid ? quality : 0,
    tests: Number(tests.status === 0),
    valid_experiment: Number(valid),
  })
);
