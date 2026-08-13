#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import {
  publishableWorkspacePackages,
  readJson,
} from "./workspace-packages.ts";

const dryRun = process.argv.includes("--dry-run");
const requestedPackageNames = process.argv
  .slice(2)
  .filter((arg) => arg !== "--dry-run");

const rootPkg = readJson("package.json");
if (rootPkg.packageManager?.startsWith("pnpm@") !== true) {
  throw new Error("Root package.json must declare packageManager: pnpm@...");
}

const publishablePackages = publishableWorkspacePackages();
const packagesByName = new Map(
  publishablePackages.map((pkg) => [pkg.name, pkg])
);

const packagesToPublish =
  requestedPackageNames.length > 0
    ? requestedPackageNames.map((name) => {
        const workspacePackage = packagesByName.get(name);
        if (workspacePackage === undefined) {
          throw new Error(
            `Unknown or non-publishable package in publish list: ${name}`
          );
        }
        return workspacePackage;
      })
    : publishablePackages;

const publishEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toLowerCase().startsWith("npm_config_")
  )
);

for (const { name } of packagesToPublish) {
  const args = ["--filter", name, "publish", "--access", "public"];
  if (dryRun) {
    args.push("--dry-run", "--no-git-checks");
  }

  console.log(`${dryRun ? "Dry-run publishing" : "Publishing"} ${name}`);
  execFileSync("pnpm", args, { env: publishEnv, stdio: "inherit" });
}
