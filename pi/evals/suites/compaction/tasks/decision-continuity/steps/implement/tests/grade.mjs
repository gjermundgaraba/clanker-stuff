import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { validateCompaction } from "./compaction.mjs";

let normalizeRelease = () => {
  throw new Error("release module did not load");
};
try {
  ({ normalizeRelease } = await import("/app/src/release.js"));
} catch {}

const tests = spawnSync("node", ["--test", "/app/test/release.test.js"], {
  encoding: "utf-8",
});
writeFileSync("/logs/verifier/tests.tap", `${tests.stdout}${tests.stderr}`);
const trajectoryPath = "/logs/agent/trajectory.json";
let trajectory = {};
try {
  trajectory = JSON.parse(readFileSync(trajectoryPath, "utf-8"));
} catch {}
const validation = validateCompaction(trajectory, { expectedSegments: [7] });

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
        }).artifacts,
      ) === JSON.stringify(["App.zip", "symbols.tgz"]),
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
        }).regions,
      ) === JSON.stringify(["us", "eu", "apac"]),
  ),
  rollout: probe(() => {
    const base = { artifacts: [], channel: "stable", regions: [] };
    const defaults = normalizeRelease(base).rolloutPercent === 100;
    const coerces = normalizeRelease({ ...base, rolloutPercent: "25" }).rolloutPercent === 25;
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
  output_contract: probe(
    () =>
      JSON.stringify(
        Object.keys(
          normalizeRelease({
            artifacts: [],
            channel: "stable",
            ignored: true,
            regions: [],
          }),
        ).sort(),
      ) === JSON.stringify(["artifacts", "channel", "regions", "rolloutPercent"].sort()),
  ),
};
let combined;
try {
  combined = normalizeRelease({
    artifacts: [" App.zip ", "app.ZIP", "symbols.tgz", ""],
    channel: " BETA ",
    ignored: true,
    regions: ["APAC", " us ", "eu"],
    rolloutPercent: "25",
  });
} catch {}
if (combined) {
  facts.artifacts &&= Number(isDeepStrictEqual(combined.artifacts, ["App.zip", "symbols.tgz"]));
  facts.channel &&= Number(combined.channel === "beta");
  facts.regions &&= Number(isDeepStrictEqual(combined.regions, ["us", "eu", "apac"]));
  facts.rollout &&= Number(combined.rolloutPercent === 25);
  facts.output_contract &&= Number(
    isDeepStrictEqual(Object.keys(combined).sort(), [
      "artifacts",
      "channel",
      "regions",
      "rolloutPercent",
    ]),
  );
} else if (Object.values(facts).every(Boolean)) {
  facts.rollout = 0;
}
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
