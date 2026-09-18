import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

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

const PackageJsonSchema = Type.Object({ name: Type.String() }, { additionalProperties: true });

export const readJson = (filePath: string): PackageJson => {
  try {
    return Value.Parse(PackageJsonSchema, JSON.parse(readFileSync(filePath, "utf-8")));
  } catch {
    throw new TypeError(`${filePath} does not contain package metadata`);
  }
};

const WorkspaceInventorySchema = Type.Array(Type.Object({ path: Type.String() }));

export const readWorkspacePackages = (root = process.cwd()): WorkspacePackage[] => {
  const workspaceRoot = realpathSync(root);

  const inventory: unknown = JSON.parse(
    execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  if (!Value.Check(WorkspaceInventorySchema, inventory)) {
    throw new TypeError("pnpm returned an invalid workspace inventory");
  }

  return inventory.map((entry) => {
    const directory = realpathSync(entry.path);
    const dir = path.relative(workspaceRoot, directory) || ".";
    const packageJsonPath = path.join(dir, "package.json");
    const packageJson = readJson(path.join(directory, "package.json"));

    return { dir, name: packageJson.name, packageJson, packageJsonPath };
  });
};

export const publishableWorkspacePackages = (root = process.cwd()): WorkspacePackage[] =>
  readWorkspacePackages(root).filter(({ packageJson }) => packageJson.private === false);
