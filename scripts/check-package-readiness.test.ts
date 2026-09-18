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
      packageManager: "pnpm@12.3.4",
      private: true,
    }),
  );
  writeFileSync(path.join(root, "LICENSE"), "fixture license\n");

  const packageJson = {
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
  };

  const packageJsonPath = path.join(packageDir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify(packageJson));
  writeFileSync(path.join(packageDir, "index.ts"), "export default () => {};\n");

  if (valid) {
    writeFileSync(path.join(packageDir, "LICENSE"), "fixture license\n");
    writeFileSync(
      path.join(packageDir, "README.md"),
      `# sample\n${includeExperimentalWarning ? "\n**Experimental:** Unstable.\n" : ""}`,
    );
  }

  return { root, packageDir, packageJsonPath, packageJson };
};

const validateFixture = ({ root }: { root: string }) =>
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

  it("requires peers for shipped sources, not unpublished build scripts", () => {
    const fixture = createFixture(true);
    const scriptDir = path.join(fixture.packageDir, "scripts");
    mkdirSync(scriptDir);
    writeFileSync(path.join(scriptDir, "build.ts"), 'import { Type } from "typebox"; void Type;\n');
    const pkg = { ...fixture.packageJson, devDependencies: { typebox: "1.3.14" } };
    writeFileSync(fixture.packageJsonPath, JSON.stringify(pkg));
    const developmentOnly = validateFixture(fixture);
    expect(developmentOnly.status, developmentOnly.stderr).toBe(0);

    // Directory name alone must not exempt a script that is actually published.
    writeFileSync(
      fixture.packageJsonPath,
      JSON.stringify({ ...pkg, files: ["index.ts", "README.md", "LICENSE", "scripts"] }),
    );
    const published = validateFixture(fixture);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain('imports typebox; add peerDependencies.typebox = "*"');
  });

  it('requires private Pi imports to use a "*" peer', () => {
    const fixture = createFixture(true);
    const { packageDir, packageJsonPath, packageJson: pkg } = fixture;
    const peerDependencies = { "@earendil-works/pi-coding-agent": "*" };
    writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, peerDependencies }));
    writeFileSync(
      path.join(packageDir, "index.ts"),
      'import { VERSION } from "@earendil-works/pi-coding-agent";\nvoid VERSION;\nexport default () => {};\n',
    );

    expect(validateFixture(fixture)).toMatchObject({ status: 0, stderr: "" });

    peerDependencies["@earendil-works/pi-coding-agent"] = "0.84.4";
    writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, peerDependencies }));
    const invalid = validateFixture(fixture);
    expect(invalid.stderr).toContain(
      '@earendil-works/pi-coding-agent peer dependency should use "*"',
    );
    expect(invalid.stderr).not.toContain("add peerDependencies");
  });

  it("allows shared library packages without extension metadata", () => {
    expect(validateFixture(createFixture(true, false))).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("allows published shared-library subpaths and rejects unpublished targets", () => {
    const fixture = createFixture(true, false);
    const { packageJsonPath, packageJson: pkg } = fixture;
    const exports = { "./dialog": "./index.ts" };
    writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, exports }));
    expect(validateFixture(fixture)).toMatchObject({ status: 0, stderr: "" });
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ ...pkg, exports, files: ["README.md", "LICENSE"] }),
    );
    expect(validateFixture(fixture).stderr).toContain(
      "must point to a published TypeScript source file",
    );
  });

  it.each([null, [], 7, { types: 7 }, { types: "./index.ts", default: "./index.ts" }])(
    "rejects unsupported export targets (%j)",
    (target) => {
      const fixture = createFixture(true, false);
      const { packageJsonPath, packageJson: pkg } = fixture;
      writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, exports: { "./bad": target } }));
      const result = validateFixture(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expected exports to be ./index.ts");
    },
  );

  it("allows published type-only extension protocols while retaining the entrypoint", () => {
    const fixture = createFixture(true);
    const { packageDir, packageJsonPath, packageJson: pkg } = fixture;
    writeFileSync(path.join(packageDir, "sampling-protocol.ts"), "export interface Scope {}\n");
    const files = ["index.ts", "README.md", "LICENSE", "sampling-protocol.ts"];
    const subpaths = { "./sampling-protocol": { types: "./sampling-protocol.ts" } };
    const exports = { ".": "./index.ts", ...subpaths };
    writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, files, exports }));
    expect(validateFixture(fixture)).toMatchObject({ status: 0, stderr: "" });
    writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, files, exports: subpaths }));
    expect(validateFixture(fixture).stderr).toContain("expected root export to be ./index.ts");
    writeFileSync(packageJsonPath, JSON.stringify({ ...pkg, exports }));
    expect(validateFixture(fixture).stderr).toContain(
      "must point to a published TypeScript source file",
    );
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
