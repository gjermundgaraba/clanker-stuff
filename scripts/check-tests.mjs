import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { readWorkspacePackages } from "./workspace-packages.mjs";

const repoRoot = process.cwd();

const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const TEST_FILE_PATTERN = /\.test\.ts$/;
const INTEGRATION_TEST_PATTERN = /\.integration\.test\.ts$/;
const SMOKE_TEST_PATTERN = /\.smoke\.test\.ts$/;
const SOURCE_FILE_PATTERN = /\.ts$/;
const IGNORED_DIRS = new Set([".git", "dist", "node_modules"]);
const AGENT_SESSION_HARNESS = path.join(
  "pi",
  "tests",
  "harness",
  "agent-session.ts"
);
const EXTENSION_SMOKE_HARNESS = path.join(
  "pi",
  "tests",
  "harness",
  "extension-smoke.ts"
);

function walkFiles(dir) {
  const results = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
      continue;
    }

    if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath);
}

function isWithinTestsDir(filePath) {
  return relativeToRepo(filePath).split(path.sep).includes("tests");
}

function getImportSpecifiers(sourceText) {
  const specifiers = [];

  for (const match of sourceText.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    specifiers.push(match[1]);
  }
  for (const match of sourceText.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    specifiers.push(match[1]);
  }

  return specifiers.filter((specifier) => specifier?.startsWith("."));
}

function resolveRelativeImport(importingFile, specifier) {
  const resolvedTarget = path.resolve(path.dirname(importingFile), specifier);
  const candidates = [];
  const extension = path.extname(resolvedTarget);

  if (extension.length > 0) {
    candidates.push(resolvedTarget);

    if (extension === ".js") {
      candidates.push(
        `${resolvedTarget.slice(0, -extension.length)}.ts`,
        `${resolvedTarget.slice(0, -extension.length)}.tsx`
      );
    }
  } else {
    candidates.push(
      resolvedTarget,
      `${resolvedTarget}.ts`,
      `${resolvedTarget}.tsx`,
      `${resolvedTarget}.js`,
      path.join(resolvedTarget, "index.ts"),
      path.join(resolvedTarget, "index.tsx"),
      path.join(resolvedTarget, "index.js")
    );
  }

  const existingTarget = candidates.find((candidate) => existsSync(candidate));
  return existingTarget ? relativeToRepo(existingTarget) : undefined;
}

function escapesPackageRoot(packageRoot, importingFile, specifier) {
  const resolvedTarget = path.resolve(path.dirname(importingFile), specifier);
  const relativeTarget = path.relative(packageRoot, resolvedTarget);

  return (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  );
}

function getPackageDirs() {
  return readWorkspacePackages()
    .map(({ dir }) => dir)
    .filter((dir) => dir !== ".")
    .sort((left, right) => left.localeCompare(right));
}

const errors = [];
for (const harnessPath of [AGENT_SESSION_HARNESS, EXTENSION_SMOKE_HARNESS]) {
  if (!existsSync(path.join(repoRoot, harnessPath))) {
    errors.push(`${harnessPath}: missing harness policy target`);
  }
}
const packageDirs = getPackageDirs();

for (const packageName of packageDirs) {
  const packageRoot = path.join(repoRoot, packageName);
  const files = walkFiles(packageRoot);
  const repoRelativeFiles = files.map(relativeToRepo);
  const testFiles = repoRelativeFiles.filter((filePath) =>
    TEST_FILE_PATTERN.test(filePath)
  );

  if (testFiles.length === 0) {
    errors.push(`${packageName}: missing test file (*.test.ts)`);
  }

  const sourceFiles = files.filter(
    (filePath) =>
      SOURCE_FILE_PATTERN.test(filePath) &&
      !TEST_FILE_PATTERN.test(filePath) &&
      !isWithinTestsDir(filePath)
  );

  for (const sourceFile of sourceFiles) {
    const sourceText = readFileSync(sourceFile, "utf8");

    for (const specifier of getImportSpecifiers(sourceText)) {
      if (escapesPackageRoot(packageRoot, sourceFile, specifier)) {
        errors.push(
          `${relativeToRepo(sourceFile)} imports ${specifier}, which resolves outside ${packageName}/`
        );
      }
    }
  }
}

for (const testFile of walkFiles(repoRoot).filter((filePath) =>
  TEST_FILE_PATTERN.test(filePath)
)) {
  const repoRelativeTestFile = relativeToRepo(testFile);
  const sourceText = readFileSync(testFile, "utf8");

  for (const specifier of getImportSpecifiers(sourceText)) {
    const resolvedImport = resolveRelativeImport(testFile, specifier);

    if (
      resolvedImport === AGENT_SESSION_HARNESS &&
      !INTEGRATION_TEST_PATTERN.test(repoRelativeTestFile)
    ) {
      errors.push(
        `${repoRelativeTestFile} imports ${specifier} (${AGENT_SESSION_HARNESS}), so it must be named *.integration.test.ts`
      );
    }

    if (
      resolvedImport === EXTENSION_SMOKE_HARNESS &&
      !SMOKE_TEST_PATTERN.test(repoRelativeTestFile)
    ) {
      errors.push(
        `${repoRelativeTestFile} imports ${specifier} (${EXTENSION_SMOKE_HARNESS}), so it must be named *.smoke.test.ts`
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Test/boundary validation failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Test/boundary validation passed for ${packageDirs.length} packages.`
);
