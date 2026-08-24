import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import { readWorkspacePackages } from "./workspace-packages.ts";

const repoRoot = process.cwd();

const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](?<specifier>[^"']+)["']/gu;
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu;
const AGENT_SESSION_HARNESS = path.join("pi", "tests", "harness", "agent-session.ts");
const EXTENSION_SMOKE_HARNESS = path.join("pi", "tests", "harness", "extension-smoke.ts");

const packageDirs = readWorkspacePackages()
  .map(({ dir }) => dir)
  .filter((dir) => dir !== ".")
  .toSorted((left, right) => left.localeCompare(right));

const findTypeScriptFiles = (directory: string): string[] =>
  globSync("**/*.ts", {
    cwd: directory,
    exclude: ["**/.git/**", "**/dist/**", "**/node_modules/**"],
  }).map((file) => path.join(directory, file));

const relativeToRepo = (filePath: string) => path.relative(repoRoot, filePath);

const isWithinTestsDir = (filePath: string) =>
  relativeToRepo(filePath).split(path.sep).includes("tests");

const getImportSpecifiers = (sourceText: string): string[] => {
  const specifiers: string[] = [];

  for (const match of sourceText.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    if (match.groups?.specifier !== undefined) {
      specifiers.push(match.groups.specifier);
    }
  }
  for (const match of sourceText.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    if (match.groups?.specifier !== undefined) {
      specifiers.push(match.groups.specifier);
    }
  }

  return specifiers.filter((specifier) => specifier.startsWith("."));
};

const resolveRelativeImport = (importingFile: string, specifier: string) => {
  const resolvedTarget = path.resolve(path.dirname(importingFile), specifier);
  const candidates: string[] = [];
  const extension = path.extname(resolvedTarget);

  if (extension.length > 0) {
    candidates.push(resolvedTarget);

    if (extension === ".js") {
      candidates.push(
        `${resolvedTarget.slice(0, -extension.length)}.ts`,
        `${resolvedTarget.slice(0, -extension.length)}.tsx`,
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
      path.join(resolvedTarget, "index.js"),
    );
  }

  const existingTarget = candidates.find((candidate) => existsSync(candidate));
  return existingTarget === undefined ? undefined : relativeToRepo(existingTarget);
};

const escapesPackageRoot = (packageRoot: string, importingFile: string, specifier: string) => {
  const resolvedTarget = path.resolve(path.dirname(importingFile), specifier);
  const relativeTarget = path.relative(packageRoot, resolvedTarget);

  return (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  );
};

const errors: string[] = [];
for (const harnessPath of [AGENT_SESSION_HARNESS, EXTENSION_SMOKE_HARNESS]) {
  if (!existsSync(path.join(repoRoot, harnessPath))) {
    errors.push(`${harnessPath}: missing harness policy target`);
  }
}
for (const packageName of packageDirs) {
  const packageRoot = path.join(repoRoot, packageName);
  const files = findTypeScriptFiles(packageRoot);
  const repoRelativeFiles = files.map(relativeToRepo);
  const testFiles = repoRelativeFiles.filter((filePath) => filePath.endsWith(".test.ts"));

  if (testFiles.length === 0) {
    errors.push(`${packageName}: missing test file (*.test.ts)`);
  }

  const sourceFiles = files.filter(
    (filePath) =>
      filePath.endsWith(".ts") && !filePath.endsWith(".test.ts") && !isWithinTestsDir(filePath),
  );

  for (const sourceFile of sourceFiles) {
    const sourceText = readFileSync(sourceFile, "utf-8");

    for (const specifier of getImportSpecifiers(sourceText)) {
      if (escapesPackageRoot(packageRoot, sourceFile, specifier)) {
        errors.push(
          `${relativeToRepo(sourceFile)} imports ${specifier}, which resolves outside ${packageName}/`,
        );
      }
    }
  }
}

for (const testFile of findTypeScriptFiles(repoRoot).filter((filePath) =>
  filePath.endsWith(".test.ts"),
)) {
  const repoRelativeTestFile = relativeToRepo(testFile);
  const sourceText = readFileSync(testFile, "utf-8");

  for (const specifier of getImportSpecifiers(sourceText)) {
    const resolvedImport = resolveRelativeImport(testFile, specifier);

    if (
      resolvedImport === AGENT_SESSION_HARNESS &&
      !repoRelativeTestFile.endsWith(".integration.test.ts")
    ) {
      errors.push(
        `${repoRelativeTestFile} imports ${specifier} (${AGENT_SESSION_HARNESS}), so it must be named *.integration.test.ts`,
      );
    }

    if (
      resolvedImport === EXTENSION_SMOKE_HARNESS &&
      !repoRelativeTestFile.endsWith(".smoke.test.ts")
    ) {
      errors.push(
        `${repoRelativeTestFile} imports ${specifier} (${EXTENSION_SMOKE_HARNESS}), so it must be named *.smoke.test.ts`,
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

console.log(`Test/boundary validation passed for ${packageDirs.length} packages.`);
