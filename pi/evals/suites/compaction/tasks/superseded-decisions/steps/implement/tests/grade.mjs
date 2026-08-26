import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { validateCompaction } from "./compaction.mjs";

let planDeployment = () => {
  throw new Error("deployment module did not load");
};
try {
  ({ planDeployment } = await import("/app/src/deployment.js"));
} catch {}

const tests = spawnSync(
  "node",
  ["--test", "/app/test/deployment.test.js", "/tests/hidden.test.js"],
  { encoding: "utf-8" },
);
writeFileSync("/logs/verifier/tests.tap", `${tests.stdout}${tests.stderr}`);

let trajectory = {};
try {
  trajectory = JSON.parse(readFileSync("/logs/agent/trajectory.json", "utf-8"));
} catch {}
const validation = validateCompaction(trajectory, { expectedSegments: [4, 9] });

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
        }).regions,
      ) === JSON.stringify(["us", "eu", "apac"]),
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
  output_contract: probe(
    () =>
      JSON.stringify(Object.keys(planDeployment({ ...base, ignored: true })).sort()) ===
      JSON.stringify(["attempts", "regions", "service", "target"].sort()),
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
    ...validation,
    quality,
    reward: quality,
    tests: Number(tests.status === 0),
  }),
);
