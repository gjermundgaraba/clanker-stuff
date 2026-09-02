import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const NPM_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
);

describe("dollah-skills package", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("does not statically expose orchestration through an omitted skill filter", async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "dollah-skills-filter-"));
    const loader = new DefaultResourceLoader({
      agentDir: path.join(tempRoot, "agent"),
      cwd: path.join(tempRoot, "project"),
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      settingsManager: SettingsManager.inMemory({
        packages: [
          {
            extensions: ["index.ts"],
            source: PACKAGE_ROOT,
          },
        ],
      }),
    });

    await loader.reload();

    expect(loader.getExtensions().errors).toStrictEqual([]);
    expect(loader.getExtensions().extensions[0]?.handlers.has("before_agent_start")).toBeTruthy();
    expect(loader.getSkills().skills).toStrictEqual([]);
  });

  it("packs the mention runtime", () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "dollah-skills-pack-"));
    const tarball = path.join(tempRoot, "dollah-skills.tgz");
    execFileSync("pnpm", ["pack", "--out", tarball], {
      cwd: PACKAGE_ROOT,
      env: NPM_ENV,
      stdio: "pipe",
    });

    expect(
      execFileSync("tar", ["-tzf", tarball], {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .toSorted(),
    ).toStrictEqual(
      [
        "package/LICENSE",
        "package/README.md",
        "package/editor.ts",
        "package/index.ts",
        "package/mentions.ts",
        "package/package.json",
      ].toSorted(),
    );
  });
});
