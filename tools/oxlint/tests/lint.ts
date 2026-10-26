import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");

// The global vp runs first-time setup under the test harness's empty HOME and reports it on stderr.
const vp = path.join(root, "node_modules", ".bin", "vp");

/** Lint one source file through the repository's registered plugin configuration. */
export function lint(source: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "anti-slop-rule-"));
  const file = path.join(directory, "input.test.ts");

  try {
    // Fixtures stay single-line; readable spacing is not the rule under test.
    writeFileSync(file, source.replaceAll("; ", ";\n\n"));

    return spawnSync(vp, ["lint", "-A", "all", "--no-ignore", file], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
