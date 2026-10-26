import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  publishableWorkspacePackages,
  readJson,
  readWorkspacePackages,
} from "./workspace-packages.ts";

const tempDirs: string[] = [];

const rootManifest = {
  name: "workspace-test",
  devEngines: { packageManager: { name: "pnpm", version: "12.3.4" } },
  private: true,
};

const fixture = (patterns = ['"packages/*"']) => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-packages-test-"));
  tempDirs.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify(rootManifest));
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    `packages:\n${patterns.map((pattern) => `  - ${pattern}`).join("\n")}\n`,
  );

  return root;
};

const addPackage = (root: string, name: string, privateValue?: boolean) => {
  const directory = path.join(root, "packages", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, private: privateValue }),
  );
};

afterEach(() => {
  vi.unstubAllEnvs();

  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("package metadata decoding", () => {
  it("preserves consumed fields, additional metadata, and opaque export formats", () => {
    const root = fixture();
    const file = path.join(root, "package.json");

    const manifest = {
      ...rootManifest,
      bugs: { url: "https://example.com/issues", email: "bugs@example.com" },
      dependencies: { "@clanker-stuff/shared": "workspace:^" },
      description: "A sample package.",
      engines: { node: ">=26", pnpm: ">=12" },
      exports: { ".": { import: "./index.js", require: "./index.cjs" } },
      files: ["index.ts"],
      homepage: "https://example.com",
      keywords: ["pi-package"],
      license: "MIT",
      peerDependencies: { typebox: "*" },
      pi: { extensions: ["./index.ts"], skills: ["./skills"] },
      publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
      repository: { directory: "packages/sample", type: "git", url: "https://example.com/repo" },
      version: "0.1.0",
      scripts: { build: "tsc" },
    };

    writeFileSync(file, JSON.stringify(manifest));
    expect(readJson(file)).toStrictEqual(manifest);
  });

  it("leaves absent policy fields absent for the readiness checker", () => {
    const root = fixture();
    const file = path.join(root, "package.json");

    const manifest = {
      name: "sample",
      bugs: {},
      engines: {},
      pi: {},
      publishConfig: {},
      repository: {},
    };

    writeFileSync(file, JSON.stringify(manifest));
    expect(readJson(file)).toStrictEqual(manifest);
  });

  it.each([
    { name: 7 },
    { description: false },
    { private: "false" },
    { files: "index.ts" },
    { files: ["index.ts", 7] },
    { keywords: [false] },
    { pi: null },
    { pi: { extensions: "./index.ts" } },
    { pi: { extensions: [7] } },
    { dependencies: ["typebox"] },
    { dependencies: { typebox: 7 } },
    { peerDependencies: { typebox: false } },
    { engines: { node: 26 } },
    { repository: "https://example.com/repo" },
    { repository: { directory: 7 } },
    { bugs: { url: false } },
    { publishConfig: { access: false } },
  ])("rejects malformed consumed metadata without coercion: %j", (change) => {
    const root = fixture();
    const file = path.join(root, "package.json");
    writeFileSync(file, JSON.stringify({ ...rootManifest, ...change }));

    expect(() => readJson(file)).toThrow(
      new TypeError(`${file} does not contain package metadata`),
    );
  });

  it.each(["{", "null", "[]", "{}"])(
    "rejects invalid JSON or missing package identity: %s",
    (text) => {
      const root = fixture();
      const file = path.join(root, "package.json");
      writeFileSync(file, text);

      expect(() => readJson(file)).toThrow(
        new TypeError(`${file} does not contain package metadata`),
      );
    },
  );
});

describe("workspace package discovery", () => {
  it("discovers root and relative package directories from an explicit symlinked root", () => {
    const root = fixture();
    addPackage(root, "sample");
    const alias = `${root}-alias`;
    symlinkSync(root, alias, "dir");
    tempDirs.push(alias);
    expect(readWorkspacePackages(alias)).toStrictEqual([
      {
        dir: ".",
        name: "workspace-test",
        packageJson: rootManifest,
        packageJsonPath: "package.json",
      },
      {
        dir: path.join("packages", "sample"),
        name: "sample",
        packageJson: { name: "sample" },
        packageJsonPath: path.join("packages", "sample", "package.json"),
      },
    ]);
  });

  it("uses pnpm exclusions and overlap rules without interpreting unrelated YAML lists", () => {
    const root = fixture([
      '"packages/*"',
      '"packages/keep"',
      '"!packages/exclude"',
      '"!packages/unrelated"',
    ]);

    for (const name of ["keep", "exclude", "unrelated"]) addPackage(root, name);
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      '\nminimumReleaseAgeExclude:\n  - "packages/unrelated"\n',
      { flag: "a" },
    );
    expect(readWorkspacePackages(root).map((pkg) => pkg.name)).toStrictEqual([
      "workspace-test",
      "keep",
    ]);
  });

  it("requires an explicit manifest private:false for publication", () => {
    const root = fixture();
    addPackage(root, "public", false);
    addPackage(root, "private", true);
    addPackage(root, "unspecified");
    expect(publishableWorkspacePackages(root).map((pkg) => pkg.name)).toStrictEqual(["public"]);
    expect(
      readWorkspacePackages(root).find((pkg) => pkg.name === "unspecified")?.packageJson.private,
    ).toBeUndefined();
  });

  it.each(["{}", '[{"path":3}]', "{"])("rejects malformed pnpm inventory %s", (output) => {
    const root = fixture();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nprintf '%s' '${output}'\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    expect(() => readWorkspacePackages(root)).toThrow();
  });

  it("surfaces package manager failures", () => {
    const root = fixture();
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: [");
    expect(() => readWorkspacePackages(root)).toThrow();
  });
});
