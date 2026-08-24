import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

describe("subagents package", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("packs and loads the production extension", async () => {
    tempRoot = mkdtempSync(path.join(PACKAGE_ROOT, ".package-smoke-"));
    const tarball = path.join(tempRoot, "subagents.tgz");
    execFileSync("pnpm", ["pack", "--out", tarball], {
      cwd: PACKAGE_ROOT,
      stdio: "pipe",
    });
    const entries = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf-8",
    })
      .trim()
      .split("\n");
    expect(entries).toContain("package/keyed-queue.ts");
    expect(entries).toContain("package/docs/protocols.md");
    expect(
      entries.some(
        (entry) =>
          entry.startsWith("package/docs/fixtures/") ||
          entry.startsWith("package/scripts/") ||
          entry === "package/docs/codex-model-facing-contract.md" ||
          entry === "package/docs/codex-parity.md" ||
          entry === "package/docs/codex-reference.md",
      ),
    ).toBeFalsy();

    const extracted = path.join(tempRoot, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
    const packageRoot = path.join(extracted, "package");
    const loader = new DefaultResourceLoader({
      agentDir: path.join(tempRoot, "agent"),
      cwd: path.join(tempRoot, "project"),
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager: SettingsManager.inMemory({
        packages: [packageRoot],
      }),
    });

    await loader.reload();

    expect(loader.getExtensions()).toMatchObject({
      errors: [],
      extensions: [{ resolvedPath: path.join(packageRoot, "index.ts") }],
    });
  });
});
