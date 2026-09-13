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

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";
import type { ExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FOOTER_ROOT = path.join(REPO_ROOT, "footer");
const USAGE_ROOT = path.join(REPO_ROOT, "usage");

describe("cooperative footer discovery", () => {
  let harness: ExtensionSmokeHarness | undefined;
  let tempRoot: string | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it("direct-loads the footer host and usage contributor together", async () => {
    harness = await createExtensionSmokeHarness({
      extensions: [FOOTER_ROOT, USAGE_ROOT],
    });

    expect(harness.extensionsResult.errors).toStrictEqual([]);
    const footer = harness.extensionsResult.extensions.find(({ resolvedPath }) =>
      resolvedPath.endsWith(path.join("footer", "index.ts")),
    );
    const usage = harness.extensionsResult.extensions.find(({ resolvedPath }) =>
      resolvedPath.endsWith(path.join("usage", "index.ts")),
    );
    expect(footer?.commands.has("footer")).toBeTruthy();
    expect(usage?.commands.has("usage")).toBeTruthy();
  });

  it("packs and loads the footer with its production entry points", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "footer-package-smoke-"));
    const workspaceRoot = path.resolve(FOOTER_ROOT, "../../../..");
    const stagingRoot = path.join(tempRoot, "workspace");
    // Legacy deploy can prune its source workspace; give it disposable sources and no links.
    for (const entry of [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "pi/extensions/experimental/footer",
      "pi/packages/footer-protocol",
      "pi/packages/extension-paths",
    ]) {
      cpSync(path.join(workspaceRoot, entry), path.join(stagingRoot, entry), {
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
    for (const dependency of [
      "@clanker-stuff/footer-protocol",
      "@clanker-stuff/pi-extension-paths",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      expect(
        realpathSync(path.join(modulesRoot, dependency)).startsWith(`${modulesRoot}${path.sep}`),
      ).toBe(true);
    }
    harness = await createExtensionSmokeHarness({ packages: [packageRoot] });
    expect(harness.extensionsResult.errors).toStrictEqual([]);
    expect(harness.extensionsResult.extensions[0]?.commands.has("footer")).toBe(true);
  }, 30_000);
});
