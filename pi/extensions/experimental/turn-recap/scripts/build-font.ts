/** vp exec jiti scripts/build-font.ts --source /path/to/font.ttf */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ROLLING_PAIRS, getRollingFontDirectory } from "../font.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(
    "Build the local rolling font: --source FONT.ttf. Requires uv. Output: " +
      getRollingFontDirectory(),
  );
} else {
  if (!values.source)
    throw new Error("--source FONT.ttf is required (use a font licensed for your intended use)");

  const result = spawnSync(
    "uv",
    [
      "run",
      fileURLToPath(new URL("./build-font.py", import.meta.url)),
      "--source",
      values.source,
      "--out",
      getRollingFontDirectory(),
      "--pairs",
      ROLLING_PAIRS.join(","),
    ],
    { stdio: "inherit" },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
