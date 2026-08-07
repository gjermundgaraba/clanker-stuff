import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const CHECK_PACKAGE_READINESS_PATH = path.join(
  import.meta.dirname,
  "check-package-readiness.mjs"
);
const tempDirs: string[] = [];

const createFixture = (valid: boolean) => {
  const root = mkdtempSync(path.join(tmpdir(), "package-readiness-test-"));
  tempDirs.push(root);
  const packageDir = path.join(root, "sample");
  mkdirSync(packageDir);

  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "."\n  - "sample"\n'
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      engines: { node: ">=24" },
      name: "clanker-stuff",
      packageManager: "pnpm@10",
      private: true,
    })
  );
  writeFileSync(path.join(root, "LICENSE"), "fixture license\n");
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      engines: { node: ">=24" },
      name: "@clanker-stuff/sample",
      private: true,
      version: "0.1.0",
      ...(valid
        ? {
            description: "Adds a sample extension.",
            exports: "./index.ts",
            files: ["index.ts", "README.md", "LICENSE"],
            keywords: ["pi-package"],
            license: "MIT",
            pi: { extensions: ["./index.ts"] },
          }
        : {}),
    })
  );
  writeFileSync(
    path.join(packageDir, "index.ts"),
    "export default () => {};\n"
  );
  if (valid) {
    writeFileSync(path.join(packageDir, "LICENSE"), "fixture license\n");
    writeFileSync(path.join(packageDir, "README.md"), "# sample\n");
  }
  return root;
};

const validateFixture = (root: string) =>
  spawnSync(process.execPath, [CHECK_PACKAGE_READINESS_PATH], {
    cwd: root,
    encoding: "utf8",
  });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("package readiness", () => {
  it("applies common extension integrity checks to private packages", () => {
    const valid = validateFixture(createFixture(true));
    const invalid = validateFixture(createFixture(false));

    expect(valid).toMatchObject({ status: 0, stderr: "" });
    expect(invalid.status).not.toBe(0);
    for (const message of [
      "missing description",
      "expected license MIT",
      "missing LICENSE",
      "missing README.md",
      "expected exports to be ./index.ts",
      "missing files allowlist",
      "extension package must include keyword pi-package",
      "extension package must declare pi.extensions",
    ]) {
      expect(invalid.stderr).toContain(message);
    }
  });
});
