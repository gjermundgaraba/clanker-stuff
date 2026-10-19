import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const PackageJsonSchema = Type.Object(
  {
    bugs: Type.Optional(
      Type.Object({ url: Type.Optional(Type.String()) }, { additionalProperties: true }),
    ),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    description: Type.Optional(Type.String()),
    engines: Type.Optional(
      Type.Object({ node: Type.Optional(Type.String()) }, { additionalProperties: true }),
    ),
    // The readiness checker owns the supported export formats.
    exports: Type.Optional(Type.Unknown()),
    files: Type.Optional(Type.Array(Type.String())),
    homepage: Type.Optional(Type.String()),
    keywords: Type.Optional(Type.Array(Type.String())),
    license: Type.Optional(Type.String()),
    name: Type.String(),
    packageManager: Type.Optional(Type.String()),
    peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    pi: Type.Optional(
      Type.Object(
        { extensions: Type.Optional(Type.Array(Type.String())) },
        { additionalProperties: true },
      ),
    ),
    private: Type.Optional(Type.Boolean()),
    publishConfig: Type.Optional(
      Type.Object({ access: Type.Optional(Type.String()) }, { additionalProperties: true }),
    ),
    repository: Type.Optional(
      Type.Object(
        {
          directory: Type.Optional(Type.String()),
          type: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
    version: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type PackageJson = Static<typeof PackageJsonSchema>;

export interface WorkspacePackage {
  dir: string;
  name: string;
  packageJson: PackageJson;
  packageJsonPath: string;
}

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
