import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

let parseRoute = () => {
  throw new Error("route module did not load");
};
try {
  ({ parseRoute } = await import("/app/src/route.js"));
} catch {}

const tests = spawnSync(
  "node",
  ["--test", "/app/test/route.test.js", "/tests/hidden.test.js"],
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
const attempts = steps
  .map((step, index) => ({ index, extra: step.extra }))
  .filter(({ extra }) => extra?.event_type === "context_compaction");
const compactions = attempts.filter(({ extra }) => extra.state === "succeeded");
const boundary = compactions.find(
  ({ extra }) =>
    extra.compacted_after_segment >= 5 && extra.compacted_after_segment <= 7
);
const mechanism =
  oracle ||
  (policy?.compactionExpected === false
    ? attempts.length === 0
    : compactions.length === 1 &&
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
    ? Boolean(boundary) &&
      attempts.length === 1 &&
      compactions.length === attempts.length &&
      mechanism &&
      continued
    : attempts.length === 0 && continued);

const probe = (fn) => {
  try {
    return Number(fn());
  } catch {
    return 0;
  }
};
const rejects = (...inputs) =>
  inputs.every((input) => {
    try {
      parseRoute(input);
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  });
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const facts = {
  api_contract: probe(
    () =>
      JSON.stringify(Object.keys(parseRoute("api/us")).sort()) ===
      JSON.stringify(["region", "service"])
  ),
  failed_attempt: probe(() => {
    const result = parseRoute(" API / EU-West-1 ");
    return result.region === "eu-west-1" && result.service === "api";
  }),
  hypothesis: probe(() => rejects(" /eu", "api/ ", " / ")),
  next_action: probe(
    () =>
      digest("/app/package.json") ===
        "17474c1b5b156290bd2bb902ea00573f3ba3c71d21c8e779e0be5c112b067c93" &&
      digest("/app/test/route.test.js") ===
        "4f90cb5c3218aa1f5881b3dec7ac1c09e9954a330ee86172294993ebca208a48"
  ),
  observed_regression: probe(() =>
    rejects(null, 42, "api", "api/eu/extra", "api//eu")
  ),
};
const quality = Object.values(facts).reduce((sum, value) => sum + value, 0) / 5;
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    ...facts,
    compaction_boundary: Number(Boolean(boundary)),
    compaction_count: compactions.length,
    continuation: Number(continued),
    mechanism: Number(mechanism),
    quality,
    reward: valid ? quality : 0,
    tests: Number(tests.status === 0),
    valid_experiment: Number(valid),
  })
);
