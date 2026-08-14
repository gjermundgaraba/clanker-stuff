#!/usr/bin/env node
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import { readWorkspacePackages } from "./workspace-packages.ts";

const PI_PROVIDED = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);
const EXPECTED_PI_PROVIDED_VERSION = "*";

const ROOT_PACKAGE_NAME = "clanker-stuff";
const EXPECTED_NODE_ENGINE = ">=24";
const EXPECTED_PACKAGE_MANAGER_PREFIX = "pnpm@";
const EXPECTED_LICENSE = "MIT";
const REPOSITORY_URL =
  "git+https://github.com/gjermundgaraba/clanker-stuff.git";
const BUGS_URL = "https://github.com/gjermundgaraba/clanker-stuff/issues";
const HOMEPAGE_PREFIX =
  "https://github.com/gjermundgaraba/clanker-stuff/tree/main/";

const collectRuntimeTsFiles = (directory: string): string[] =>
  globSync("**/*.ts", {
    cwd: directory,
    exclude: ["**/.*", "**/node_modules/**", "**/tests/**", "**/*.test.ts"],
  }).map((file) => path.join(directory, file));

const matchesPackageSpecifier = (specifier: string, packageName: string) =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const importedPiProvidedPackages = (directory: string): Set<string> => {
  const imported = new Set<string>();
  const importRe =
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](?<specifier>[^"']+)["']/gu;
  for (const file of collectRuntimeTsFiles(directory)) {
    const text = readFileSync(file, "utf-8");
    for (const match of text.matchAll(importRe)) {
      const specifier = match.groups?.specifier;
      if (specifier === undefined) {
        continue;
      }
      for (const packageName of PI_PROVIDED) {
        if (matchesPackageSpecifier(specifier, packageName)) {
          imported.add(packageName);
          break;
        }
      }
    }
  }
  return imported;
};

const pathExistsForEntry = (packageDirectory: string, entry: string) =>
  entry.includes("*") ||
  entry.includes("?") ||
  existsSync(path.join(packageDirectory, entry));

const errors: string[] = [];
const workspacePackages = readWorkspacePackages();
const sharedRuntimePackages = new Set(
  workspacePackages
    .filter(({ dir }) => dir.startsWith("pi/packages/"))
    .map(({ name }) => name)
);
const rootLicensePath = "LICENSE";
const rootLicense = existsSync(rootLicensePath)
  ? readFileSync(rootLicensePath, "utf-8")
  : undefined;

if (rootLicense === undefined) {
  errors.push("LICENSE: root MIT license file is missing");
}

for (const { dir, packageJson: pkg, packageJsonPath } of workspacePackages) {
  const label = packageJsonPath;
  const isRoot = pkg.name === ROOT_PACKAGE_NAME;

  if (pkg.engines?.node !== EXPECTED_NODE_ENGINE) {
    errors.push(`${label}: expected engines.node ${EXPECTED_NODE_ENGINE}`);
  }

  if (isRoot) {
    if (pkg.private !== true) {
      errors.push(`${label}: root package must stay private`);
    }
    if (
      pkg.packageManager?.startsWith(EXPECTED_PACKAGE_MANAGER_PREFIX) !== true
    ) {
      errors.push(
        `${label}: expected packageManager to start with ${EXPECTED_PACKAGE_MANAGER_PREFIX}`
      );
    }
    continue;
  }

  if (pkg.version === undefined || pkg.version.length === 0) {
    errors.push(`${label}: missing version`);
  }
  if (pkg.description === undefined || pkg.description.length === 0) {
    errors.push(`${label}: missing description`);
  }
  if (pkg.license !== EXPECTED_LICENSE) {
    errors.push(`${label}: expected license ${EXPECTED_LICENSE}`);
  }
  const packageLicensePath = path.join(dir, "LICENSE");
  if (!existsSync(packageLicensePath)) {
    errors.push(`${label}: missing LICENSE`);
  } else if (
    rootLicense !== undefined &&
    readFileSync(packageLicensePath, "utf-8") !== rootLicense
  ) {
    errors.push(`${label}: LICENSE must match the root LICENSE`);
  }
  if (!existsSync(path.join(dir, "README.md"))) {
    errors.push(`${label}: missing README.md`);
  }
  if (pkg.exports !== "./index.ts") {
    errors.push(`${label}: expected exports to be ./index.ts`);
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    errors.push(`${label}: missing files allowlist`);
  } else {
    for (const entry of pkg.files) {
      if (!pathExistsForEntry(dir, entry)) {
        errors.push(`${label}: files entry does not exist: ${entry}`);
      }
    }
  }
  const isExtensionPackage = dir.startsWith("pi/extensions/");
  if (isExtensionPackage) {
    if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
      errors.push(
        `${label}: extension package must include keyword pi-package`
      );
    }
    if (
      pkg.pi === undefined ||
      !Array.isArray(pkg.pi.extensions) ||
      pkg.pi.extensions.length === 0
    ) {
      errors.push(`${label}: extension package must declare pi.extensions`);
    } else {
      for (const entry of pkg.pi.extensions) {
        if (!pathExistsForEntry(dir, entry)) {
          errors.push(`${label}: pi.extensions entry does not exist: ${entry}`);
        }
      }
    }
  }

  if (pkg.private === true) {
    continue;
  }
  if (pkg.private !== false) {
    errors.push(`${label}: publishable packages must set private: false`);
  }
  if (
    pkg.repository?.type !== "git" ||
    pkg.repository?.url !== REPOSITORY_URL
  ) {
    errors.push(`${label}: expected repository URL ${REPOSITORY_URL}`);
  }
  if (pkg.repository?.directory !== dir) {
    errors.push(`${label}: expected repository.directory ${dir}`);
  }
  if (pkg.bugs?.url !== BUGS_URL) {
    errors.push(`${label}: expected bugs.url ${BUGS_URL}`);
  }
  if (pkg.homepage !== `${HOMEPAGE_PREFIX}${dir}#readme`) {
    errors.push(`${label}: expected homepage ${HOMEPAGE_PREFIX}${dir}#readme`);
  }
  if (pkg.publishConfig?.access !== "public") {
    errors.push(`${label}: expected publishConfig.access to be public`);
  }

  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (
      name.startsWith("@clanker-stuff/") &&
      !sharedRuntimePackages.has(name)
    ) {
      errors.push(`${label}: unapproved shared runtime dependency ${name}`);
    }
    if (PI_PROVIDED.has(name)) {
      errors.push(
        `${label}: ${name} belongs in peerDependencies, not dependencies`
      );
    }
    if (version === "workspace:*") {
      errors.push(
        `${label}: use workspace:^ instead of workspace:* for ${name}`
      );
    }
  }

  for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
    if (
      PI_PROVIDED.has(name) &&
      name !== "typebox" &&
      version !== EXPECTED_PI_PROVIDED_VERSION
    ) {
      errors.push(
        `${label}: ${name} peer dependency should use "${EXPECTED_PI_PROVIDED_VERSION}"`
      );
    }
    if (version === "workspace:*") {
      errors.push(
        `${label}: use workspace:^ instead of workspace:* for ${name}`
      );
    }
  }

  for (const name of importedPiProvidedPackages(dir)) {
    const expectedVersion =
      name === "typebox" ? "*" : EXPECTED_PI_PROVIDED_VERSION;
    if (pkg.peerDependencies?.[name] !== expectedVersion) {
      errors.push(
        `${label}: imports ${name}; add peerDependencies.${name} = "${expectedVersion}"`
      );
    }
  }
}

if (errors.length > 0) {
  console.error(
    `Package readiness check failed with ${errors.length} issue${errors.length === 1 ? "" : "s"}:`
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Package readiness check passed.");
