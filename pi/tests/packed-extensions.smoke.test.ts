import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { publishableWorkspacePackages } from "../../scripts/workspace-packages.ts";
import { createExtensionSmokeHarness } from "./harness/extension-smoke.js";
import type { ExtensionSmokeHarness } from "./harness/extension-smoke.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const ROOT_DEV_DEPENDENCIES = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
    devDependencies: Record<string, string>;
  }
).devDependencies;
const CONSUMER_DEPENDENCIES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
] as const;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const PUBLISHABLE_PACKAGES = publishableWorkspacePackages(REPO_ROOT);
const EXTENSION_PACKAGE_DIR = /^pi[\\/]extensions[\\/]/u;
const EXTENSION_PACKAGES = PUBLISHABLE_PACKAGES.flatMap(
  ({ dir, name, packageJson }) => {
    if (!EXTENSION_PACKAGE_DIR.test(dir)) {
      return [];
    }
    if (
      !Array.isArray(packageJson.pi?.extensions) ||
      packageJson.pi.extensions.length === 0
    ) {
      throw new Error(`${name} must declare non-empty pi.extensions`);
    }
    return [{ dir, entries: packageJson.pi.extensions, name }];
  }
);
const SHARED_PACKAGES = PUBLISHABLE_PACKAGES.filter(
  ({ dir }) => !EXTENSION_PACKAGE_DIR.test(dir)
);

const packPackage = (tempRoot: string, packageName: string, dir: string) => {
  const packDir = path.join(tempRoot, "packs", dir);
  mkdirSync(packDir, { recursive: true });
  execFileSync(
    "pnpm",
    ["--filter", packageName, "pack", "--pack-destination", packDir],
    { cwd: REPO_ROOT, stdio: "pipe" }
  );
  const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one tarball for ${packageName}, found ${tarballs.length}`
    );
  }
  return path.join(packDir, tarballs[0]);
};

const inspectTarball = (packageName: string, tarball: string) => {
  const entries = execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf-8",
  }).split("\n");
  expect(entries, `${packageName} packed files`).toContain("package/LICENSE");

  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf-8",
    })
  ) as Record<string, Record<string, unknown> | undefined>;
  const workspaceDependencies = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(packageJson[field] ?? {}).flatMap(([name, version]) =>
      typeof version === "string" && version.startsWith("workspace:")
        ? [`${field}.${name}=${version}`]
        : []
    )
  );
  expect(workspaceDependencies, `${packageName} dependencies`).toStrictEqual(
    []
  );
};

describe("packed extension packages", () => {
  let harness: ExtensionSmokeHarness | undefined;
  let tempRoot: string | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("installs and loads every packed npm artifact", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "packed-extensions-smoke-"));
    const sharedTarballs = SHARED_PACKAGES.map(({ dir, name }) => {
      const tarball = packPackage(tempRoot ?? "", name, dir);
      inspectTarball(name, tarball);
      return { name, tarball };
    });
    const tarballs = EXTENSION_PACKAGES.map(({ dir, name }) => {
      const tarball = packPackage(tempRoot ?? "", name, dir);
      inspectTarball(name, tarball);
      return { name, tarball };
    });
    const installDir = path.join(tempRoot, "install");
    mkdirSync(installDir);
    writeFileSync(
      path.join(installDir, "package.json"),
      `${JSON.stringify(
        {
          dependencies: Object.fromEntries([
            ...CONSUMER_DEPENDENCIES.map((name) => [
              name,
              ROOT_DEV_DEPENDENCIES[name],
            ]),
            ...[...sharedTarballs, ...tarballs].map(({ name, tarball }) => [
              name,
              `file:${tarball}`,
            ]),
          ]),
          private: true,
        },
        null,
        2
      )}\n`
    );
    const npmEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toLowerCase().startsWith("npm_config_")
      )
    );
    const emptyGlobalConfig = path.join(tempRoot, "empty-global.npmrc");
    const emptyUserConfig = path.join(tempRoot, "empty-user.npmrc");
    writeFileSync(emptyGlobalConfig, "");
    writeFileSync(emptyUserConfig, "");
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: installDir,
        env: {
          ...npmEnv,
          NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
          NPM_CONFIG_USERCONFIG: emptyUserConfig,
        },
        stdio: "pipe",
      }
    );

    const packageDirs = EXTENSION_PACKAGES.map(({ name }) =>
      path.join(installDir, "node_modules", ...name.split("/"))
    );

    harness = await createExtensionSmokeHarness({ packages: packageDirs });
    expect(harness.extensionsResult.errors).toStrictEqual([]);

    for (const [index, expected] of EXTENSION_PACKAGES.entries()) {
      for (const entry of expected.entries) {
        const expectedEntryPath = path.resolve(packageDirs[index], entry);
        const extension = harness.extensionsResult.extensions.find(
          ({ resolvedPath }) => resolvedPath === expectedEntryPath
        );
        if (extension === undefined) {
          throw new Error(`Packed extension did not load: ${expected.name}`);
        }
        expect(
          [
            extension.commands,
            extension.entryRenderers,
            extension.flags,
            extension.handlers,
            extension.messageRenderers,
            extension.shortcuts,
            extension.tools,
          ].some((registrations) => (registrations?.size ?? 0) > 0),
          `${expected.name} registered a runtime surface`
        ).toBeTruthy();
      }
    }
  }, 120_000);
});
