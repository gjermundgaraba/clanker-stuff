import { existsSync, readFileSync } from "node:fs";
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
  return readFileSync("pnpm-workspace.yaml", "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*"([^"]+)"\s*$/)?.[1])
    .filter(Boolean);
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
