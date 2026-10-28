import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { validateCompaction } from "./compaction.mjs";

/** @type {typeof import("../solution/route.js").parseRoute} */
const missingCandidate = () => {
  throw new Error("route module did not load");
};

const loadCandidate = async () => {
  try {
    const { parseRoute: candidate } = await import("/app/src/route.js");

    return candidate;
  } catch {
    return missingCandidate;
  }
};

const parseRoute = await loadCandidate();

const tests = spawnSync("node", ["--test", "/app/test/route.test.js"], {
  encoding: "utf-8",
});

writeFileSync("/logs/verifier/tests.tap", `${tests.stdout}${tests.stderr}`);

const readTrajectory = () => {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(
      readFileSync("/logs/agent/trajectory.json", "utf-8")
    );

    return parsed;
  } catch {
    return {};
  }
};

const trajectory = readTrajectory();

const validation = validateCompaction(trajectory, { expectedSegments: [7] });

/** @param {()=>boolean} fn */
const probe = (fn) => {
  try {
    return Number(fn());
  } catch {
    return 0;
  }
};

/** @param {...unknown} inputs */
const rejects = (...inputs) =>
  inputs.every((input) => {
    try {
      parseRoute(input);

      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  });

/** @param {string} path */
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const facts = {
  api_contract: probe(
    () =>
      JSON.stringify(Object.keys(parseRoute("api/us")).toSorted()) ===
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
        "570fb26adacdfd9840664a96f7485a5255324eef61d187e614ca058ce8449a75"
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
    ...validation,
    quality,
    reward: quality,
    tests: Number(tests.status === 0),
  })
);
