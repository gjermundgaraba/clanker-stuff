import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const CHECK_PACKAGE_READINESS_PATH = path.join(import.meta.dirname, "check-package-readiness.ts");
const tempDirs: string[] = [];

const createFixture = (
  valid: boolean,
  extension = true,
  experimental = extension,
  packagePrivate = true,
  includeExperimentalWarning = experimental,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "package-readiness-test-"));
  tempDirs.push(root);
  const packagePath = extension
    ? `pi/extensions/${experimental ? "experimental/" : ""}sample`
    : "pi/packages/sample";
  const packageDir = path.join(root, packagePath);
  mkdirSync(packageDir, { recursive: true });

  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    `packages:\n  - "."\n  - "${packagePath}"\n`,
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      engines: { node: ">=26" },
      name: "clanker-stuff",
      packageManager: "pnpm@11",
      private: true,
    }),
  );
  writeFileSync(path.join(root, "LICENSE"), "fixture license\n");
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      bugs:
        valid && !packagePrivate
          ? { url: "https://github.com/gjermundgaraba/clanker-stuff/issues" }
          : undefined,
      description: valid ? "Adds a sample extension." : undefined,
      engines: { node: ">=26" },
      exports: valid ? "./index.ts" : undefined,
      files: valid ? ["index.ts", "README.md", "LICENSE"] : undefined,
      homepage:
        valid && !packagePrivate
          ? `https://github.com/gjermundgaraba/clanker-stuff/tree/main/${packagePath}#readme`
          : undefined,
      keywords: valid && extension ? ["pi-package"] : undefined,
      license: valid ? "MIT" : undefined,
      name: "@clanker-stuff/sample",
      pi: valid && extension ? { extensions: ["./index.ts"] } : undefined,
      private: packagePrivate,
      publishConfig: valid && !packagePrivate ? { access: "public" } : undefined,
      repository:
        valid && !packagePrivate
          ? {
              directory: packagePath,
              type: "git",
              url: "git+https://github.com/gjermundgaraba/clanker-stuff.git",
            }
          : undefined,
      version: "0.1.0",
    }),
  );
  writeFileSync(path.join(packageDir, "index.ts"), "export default () => {};\n");
  if (valid) {
    writeFileSync(path.join(packageDir, "LICENSE"), "fixture license\n");
    writeFileSync(
      path.join(packageDir, "README.md"),
      `# sample\n${includeExperimentalWarning ? "\n**Experimental:** Unstable.\n" : ""}`,
    );
  }
  return root;
};

const validateFixture = (root: string) =>
  spawnSync(process.execPath, [CHECK_PACKAGE_READINESS_PATH], {
    cwd: root,
    encoding: "utf-8",
  });

describe("package readiness", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

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

  it("allows shared library packages without extension metadata", () => {
    expect(validateFixture(createFixture(true, false))).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it.each([
    [
      "stable",
      () => createFixture(true, true, false),
      "stable extension packages must set private: false",
    ],
    [
      "experimental",
      () => createFixture(true, true, true, false),
      "experimental extension packages must set private: true",
    ],
  ])("enforces %s extension publication state", (_label, fixture, message) => {
    expect(validateFixture(fixture()).stderr).toContain(message);
  });

  it("accepts a valid stable extension package", () => {
    expect(validateFixture(createFixture(true, true, false, false))).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("requires experimental packages to warn in their README", () => {
    const result = validateFixture(createFixture(true, true, true, true, false));

    expect(result.stderr).toContain("experimental extension README must include **Experimental:**");
  });
});
