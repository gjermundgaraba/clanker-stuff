#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readWorkspacePackages } from "./workspace-packages.mjs";

const PI_PROVIDED = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);
const EXPECTED_PI_PROVIDED_VERSION = "*";

const ROOT_PACKAGE_NAME = "clanker-extensions";
const EXPECTED_NODE_ENGINE = ">=24";
const EXPECTED_PACKAGE_MANAGER_PREFIX = "pnpm@";
const EXPECTED_LICENSE = "MIT";
const REPOSITORY_URL =
  "git+https://github.com/gjermundgaraba/clanker-extensions.git";
const BUGS_URL = "https://github.com/gjermundgaraba/clanker-extensions/issues";
const HOMEPAGE_PREFIX =
  "https://github.com/gjermundgaraba/clanker-extensions/tree/main/";

function collectRuntimeTsFiles(dir) {
  const files = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "tests") continue;
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      if (entry.name.endsWith(".integration.test.ts")) continue;
      if (entry.name.endsWith(".smoke.test.ts")) continue;
      files.push(fullPath);
    }
  }
  walk(dir);
  return files;
}

function matchesPackageSpecifier(spec, packageName) {
  return spec === packageName || spec.startsWith(`${packageName}/`);
}

function importedPiProvidedPackages(dir) {
  const imported = new Set();
  const importRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
  for (const file of collectRuntimeTsFiles(dir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const spec = match[1];
      for (const packageName of PI_PROVIDED) {
        if (matchesPackageSpecifier(spec, packageName)) {
          imported.add(packageName);
          break;
        }
      }
    }
  }
  return imported;
}

function pathExistsForEntry(packageDir, entry) {
  if (entry.includes("*") || entry.includes("?")) return true;
  return existsSync(join(packageDir, entry));
}

function hasIndexExport(pkg) {
  return pkg.exports === "./index.ts";
}

const errors = [];
const workspacePackages = readWorkspacePackages();
const rootLicensePath = "LICENSE";
const rootLicense = existsSync(rootLicensePath)
  ? readFileSync(rootLicensePath, "utf8")
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
    if (pkg.private !== true)
      errors.push(`${label}: root package must stay private`);
    if (!pkg.packageManager?.startsWith(EXPECTED_PACKAGE_MANAGER_PREFIX)) {
      errors.push(
        `${label}: expected packageManager to start with ${EXPECTED_PACKAGE_MANAGER_PREFIX}`
      );
    }
    continue;
  }

  if (!pkg.version) errors.push(`${label}: missing version`);
  if (!pkg.description) errors.push(`${label}: missing description`);
  if (pkg.license !== EXPECTED_LICENSE) {
    errors.push(`${label}: expected license ${EXPECTED_LICENSE}`);
  }
  const packageLicensePath = join(dir, "LICENSE");
  if (!existsSync(packageLicensePath)) {
    errors.push(`${label}: missing LICENSE`);
  } else if (
    rootLicense !== undefined &&
    readFileSync(packageLicensePath, "utf8") !== rootLicense
  ) {
    errors.push(`${label}: LICENSE must match the root LICENSE`);
  }
  if (!existsSync(join(dir, "README.md")))
    errors.push(`${label}: missing README.md`);
  if (!hasIndexExport(pkg))
    errors.push(`${label}: expected exports to be ./index.ts`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    errors.push(`${label}: missing files allowlist`);
  } else {
    for (const entry of pkg.files) {
      if (!pathExistsForEntry(dir, entry))
        errors.push(`${label}: files entry does not exist: ${entry}`);
    }
  }
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
    errors.push(`${label}: extension package must include keyword pi-package`);
  }
  if (
    !pkg.pi ||
    !Array.isArray(pkg.pi.extensions) ||
    pkg.pi.extensions.length === 0
  ) {
    errors.push(`${label}: extension package must declare pi.extensions`);
  } else {
    for (const entry of pkg.pi.extensions) {
      if (!pathExistsForEntry(dir, entry))
        errors.push(`${label}: pi.extensions entry does not exist: ${entry}`);
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
    if (name.startsWith("@clanker-extensions/")) {
      errors.push(
        `${label}: published extensions must be standalone; remove ${name}`
      );
    }
    if (PI_PROVIDED.has(name)) {
      errors.push(
        `${label}: ${name} belongs in peerDependencies, not dependencies`
      );
    }
    if (typeof version === "string" && version === "workspace:*") {
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
    if (typeof version === "string" && version === "workspace:*") {
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
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Package readiness check passed.");
