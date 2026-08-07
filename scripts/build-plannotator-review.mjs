#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIRECTORY = path.join(ROOT, "pi/extensions/plannotator");
const FILES = ["review-launcher.ts", "cli.ts"];
const OUTPUT_DIRECTORIES = [
  "claude/plugins/plannotator/skills/plannotator-review/scripts",
  "codex/plugins/plannotator/skills/plannotator-review/scripts",
];
const check = process.argv.includes("--check");
const stale = [];

for (const directory of OUTPUT_DIRECTORIES) {
  const outputDirectory = path.join(ROOT, directory);
  if (!check) {
    mkdirSync(outputDirectory, { recursive: true });
  }
  for (const file of FILES) {
    const source = path.join(SOURCE_DIRECTORY, file);
    const output = path.join(outputDirectory, file);
    const obsolete = output.replace(/\.ts$/u, ".mjs");
    if (check) {
      if (
        !existsSync(output) ||
        !readFileSync(output).equals(readFileSync(source))
      ) {
        stale.push(path.relative(ROOT, output));
      }
      if (existsSync(obsolete)) {
        stale.push(path.relative(ROOT, obsolete));
      }
    } else {
      copyFileSync(source, output);
      rmSync(obsolete, { force: true });
    }
  }
}

if (stale.length > 0) {
  throw new Error(
    `Generated Plannotator review scripts are stale:\n${stale.join("\n")}\nRun pnpm build:plannotator-review.`
  );
}
