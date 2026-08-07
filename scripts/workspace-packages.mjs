import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALL_DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readWorkspaceDirs() {
  const dirs = readFileSync("pnpm-workspace.yaml", "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/u)?.[1])
    .filter(Boolean)
    .flatMap((dir) => (dir.includes("*") ? globSync(dir) : dir));

  if (dirs.every((dir) => dir === ".")) {
    throw new Error("pnpm-workspace.yaml discovered no package directories");
  }

  return dirs;
}

export function readWorkspacePackages() {
  return readWorkspaceDirs()
    .map((dir) => {
      const packageJsonPath = join(dir, "package.json");
      if (!existsSync(packageJsonPath)) return undefined;
      const packageJson = readJson(packageJsonPath);
      return {
        dir,
        name: packageJson.name,
        packageJson,
        packageJsonPath,
      };
    })
    .filter(Boolean);
}

export function publishableWorkspacePackages() {
  return readWorkspacePackages().filter(
    ({ packageJson }) => packageJson.private === false
  );
}
