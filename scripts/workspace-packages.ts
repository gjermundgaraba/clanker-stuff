import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

export interface PackageJson {
  bugs?: { url?: string };
  dependencies?: Record<string, string>;
  description?: string;
  engines?: { node?: string };
  exports?: unknown;
  files?: string[];
  homepage?: string;
  keywords?: string[];
  license?: string;
  name: string;
  packageManager?: string;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
  private?: boolean;
  publishConfig?: { access?: string };
  repository?: { directory?: string; type?: string; url?: string };
  version?: string;
}

export interface WorkspacePackage {
  dir: string;
  name: string;
  packageJson: PackageJson;
  packageJsonPath: string;
}

export const readJson = (filePath: string): PackageJson => {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("name" in parsed) ||
    typeof parsed.name !== "string"
  ) {
    throw new TypeError(`${filePath} does not contain package metadata`);
  }
  return { ...parsed, name: parsed.name };
};

const readWorkspaceDirs = (root: string): string[] => {
  const dirs = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf-8")
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match =
        /^\s*-\s*["']?(?<directory>[^"'#]+?)["']?\s*(?:#.*)?$/u.exec(line);
      const directory = match?.groups?.directory;
      return directory === undefined || directory.length === 0
        ? []
        : [directory];
    })
    .flatMap((directory) =>
      directory.includes("*") ? globSync(directory, { cwd: root }) : [directory]
    );

  if (dirs.every((directory) => directory === ".")) {
    throw new Error("pnpm-workspace.yaml discovered no package directories");
  }

  return dirs;
};

export const readWorkspacePackages = (
  root = process.cwd()
): WorkspacePackage[] =>
  readWorkspaceDirs(root).flatMap((directory) => {
    const packageJsonPath = path.join(directory, "package.json");
    const absolutePackageJsonPath = path.join(root, packageJsonPath);
    if (!existsSync(absolutePackageJsonPath)) {
      return [];
    }
    const packageJson = readJson(absolutePackageJsonPath);
    return [
      {
        dir: directory,
        name: packageJson.name,
        packageJson,
        packageJsonPath,
      },
    ];
  });

export const publishableWorkspacePackages = (
  root = process.cwd()
): WorkspacePackage[] =>
  readWorkspacePackages(root).filter(
    ({ packageJson }) => packageJson.private === false
  );
