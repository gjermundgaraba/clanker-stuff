import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vite-plus/test";

it("ships both anti-slop and Stylistic license notices in the installed payload", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const fixture = mkdtempSync(path.join(tmpdir(), "anti-slop-license-"));

  try {
    const target = path.join(fixture, "plugin");

    const result = spawnSync(
      process.execPath,
      [path.join(root, "skills/install-anti-slop/scripts/install.mjs"), target],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(target, "LICENSE"), "utf8")).toBe(
      readFileSync(path.join(root, "tools/oxlint/anti-slop/LICENSE"), "utf8"),
    );
    expect(readFileSync(path.join(target, "LICENSE"), "utf8")).toContain(
      "Copyright (c) 2026 Dillon Mulroy",
    );
    expect(readFileSync(path.join(target, "vendor/eslint-stylistic/LICENSE"), "utf8")).toContain(
      "MIT",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
