import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readWorkspacePackages } from "./workspace-packages.ts";

const tempDirs: string[] = [];

describe("workspace package discovery", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("discovers relative package directories from an explicit root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-packages-test-"));
    tempDirs.push(root);
    mkdirSync(path.join(root, "packages", "sample"), { recursive: true });
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n'
    );
    writeFileSync(
      path.join(root, "packages", "sample", "package.json"),
      JSON.stringify({ name: "sample" })
    );

    expect(readWorkspacePackages(root)).toStrictEqual([
      {
        dir: path.join("packages", "sample"),
        name: "sample",
        packageJson: { name: "sample" },
        packageJsonPath: path.join("packages", "sample", "package.json"),
      },
    ]);
  });
});
