import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readJson, readWorkspacePackages } from "../../../../../scripts/workspace-packages.ts";
import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";
import type { ExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

const FOOTER_ROOT = path.resolve(import.meta.dirname, "..");

const WORKSPACE_ROOT = path.resolve(FOOTER_ROOT, "../../../..");

const MANIFEST = readJson(path.join(FOOTER_ROOT, "package.json"));

/** The footer's workspace dependencies and theirs, so staging follows the manifest. */
const workspaceDependencyDirs = (): string[] => {
  const workspace = new Map(readWorkspacePackages(WORKSPACE_ROOT).map((pkg) => [pkg.name, pkg]));
  const dirs = new Set<string>();
  const pending = Object.keys(MANIFEST.dependencies ?? {});

  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const pkg = workspace.get(name);

    if (pkg === undefined || dirs.has(pkg.dir)) continue;
    dirs.add(pkg.dir);
    pending.push(...Object.keys(pkg.packageJson.dependencies ?? {}));
  }

  return [...dirs];
};

describe("footer discovery", () => {
  let harness: ExtensionSmokeHarness | undefined;
  let tempRoot: string | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;

    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it("packs and loads the footer with its production entry points", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "footer-package-smoke-"));
    const stagingRoot = path.join(tempRoot, "workspace");

    // Legacy deploy can prune its source workspace; give it disposable sources and no links.
    for (const entry of [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      path.relative(WORKSPACE_ROOT, FOOTER_ROOT),
      ...workspaceDependencyDirs(),
    ]) {
      cpSync(path.join(WORKSPACE_ROOT, entry), path.join(stagingRoot, entry), {
        recursive: true,
        filter: (source) => path.basename(source) !== "node_modules",
      });
    }

    const deployed = path.join(tempRoot, "deployed");
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@clanker-stuff/footer",
        "deploy",
        "--prod",
        "--legacy",
        "--frozen-lockfile",
        "--ignore-scripts",
        deployed,
      ],
      { cwd: stagingRoot, stdio: "pipe" },
    );
    const tarball = path.join(tempRoot, "footer.tgz");
    execFileSync("pnpm", ["pack", "--out", tarball], {
      cwd: FOOTER_ROOT,
      stdio: "pipe",
    });
    const extracted = path.join(tempRoot, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
    const packageRoot = realpathSync(path.join(extracted, "package"));
    const modulesRoot = path.join(packageRoot, "node_modules");
    // Keep only deployed dependencies so unpacked source omissions cannot be masked.
    renameSync(path.join(deployed, "node_modules"), modulesRoot);
    rmSync(deployed, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });

    for (const entry of readdirSync(modulesRoot, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        expect(
          realpathSync(path.join(entry.parentPath, entry.name)).startsWith(
            `${modulesRoot}${path.sep}`,
          ),
        ).toBe(true);
      }
    }

    // Peers are host-provided: Pi supplies them to the loaded extension.
    for (const dependency of Object.keys(MANIFEST.dependencies ?? {})) {
      expect(
        realpathSync(path.join(modulesRoot, dependency)).startsWith(`${modulesRoot}${path.sep}`),
      ).toBe(true);
    }

    harness = await createExtensionSmokeHarness({ packages: [packageRoot] });
    expect(harness.extensionsResult.errors).toStrictEqual([]);
    expect(harness.extensionsResult.extensions[0]?.commands.has("footer")).toBe(true);
  });
});
