import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHECKPOINT_CUSTOM_TYPE } from "../checkpoint.js";
import * as packageEntry from "../index.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXPECTED_ENTRY = path.join(PACKAGE_ROOT, "index.ts");
const SENSITIVE_HOOKS = [
  "context",
  "before_provider_headers",
  "before_provider_request",
  "session_before_compact",
] as const;
const NPM_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toLowerCase().startsWith("npm_config_")
  )
);

const loadPackage = async (packageRoot: string, rootDir: string) => {
  const settingsManager = SettingsManager.inMemory({
    packages: [packageRoot],
  });
  const loader = new DefaultResourceLoader({
    agentDir: path.join(rootDir, "agent"),
    cwd: path.join(rootDir, "project"),
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });
  await loader.reload();
  return loader.getExtensions();
};

describe("codex-provider package", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
    vi.unstubAllEnvs();
  });

  it("discovers only the combined default production extension", async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "codex-package-source-"));
    const agentDir = path.join(tempRoot, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const result = await loadPackage(PACKAGE_ROOT, tempRoot);
    const extension = result.extensions.find(
      ({ resolvedPath }) => resolvedPath === EXPECTED_ENTRY
    );

    expect({
      command: extension?.commands.has("codex-provider"),
      entryRenderer: extension?.entryRenderers?.has(CHECKPOINT_CUSTOM_TYPE),
      errors: result.errors,
      exports: Object.keys(packageEntry),
      sensitiveHooks: SENSITIVE_HOOKS.filter((hook) =>
        extension?.handlers.has(hook)
      ),
    }).toStrictEqual({
      command: true,
      entryRenderer: true,
      errors: [],
      exports: ["default"],
      sensitiveHooks: [...SENSITIVE_HOOKS],
    });
    expect(
      existsSync(path.join(agentDir, "codex-provider.sqlite"))
    ).toBeFalsy();
  });

  it("packs, installs, and loads with production peer resolution", async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "codex-package-pack-"));
    const packDir = path.join(tempRoot, "pack");
    mkdirSync(packDir);
    const rawPackOutput: unknown = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
        cwd: PACKAGE_ROOT,
        encoding: "utf-8",
        env: NPM_ENV,
      })
    );
    let packOutput: unknown;
    if (Array.isArray(rawPackOutput)) {
      [packOutput] = rawPackOutput;
    } else if (rawPackOutput && typeof rawPackOutput === "object") {
      [packOutput] = Object.values(rawPackOutput);
    }
    const filename =
      packOutput &&
      typeof packOutput === "object" &&
      "filename" in packOutput &&
      typeof packOutput.filename === "string"
        ? packOutput.filename
        : undefined;
    if (!filename) {
      throw new Error("npm pack did not produce a tarball");
    }
    const tarball = path.join(packDir, filename);
    const entries = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .toSorted();
    expect(entries).toStrictEqual(
      [
        "package/LICENSE",
        "package/README.md",
        "package/checkpoint.ts",
        "package/docs/codex-baseline.md",
        "package/docs/context-alignment.md",
        "package/docs/design.md",
        "package/docs/evaluation.md",
        "package/docs/live-canary.md",
        "package/docs/local-deployment.md",
        "package/index.ts",
        "package/lifecycle.ts",
        "package/observability.ts",
        "package/package.json",
        "package/provider.ts",
        "package/renderer.ts",
        "package/replay.ts",
        "package/status.ts",
      ].toSorted()
    );
    const installDir = path.join(tempRoot, "install");
    mkdirSync(installDir);
    writeFileSync(
      path.join(installDir, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "@clanker-stuff/codex-provider": `file:${tarball}`,
            "@earendil-works/pi-ai": "0.84.0",
            "@earendil-works/pi-coding-agent": "0.84.0",
            "@earendil-works/pi-tui": "0.84.0",
          },
          private: true,
        },
        null,
        2
      )}\n`
    );
    execFileSync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: installDir,
        env: NPM_ENV,
        stdio: "pipe",
      }
    );
    const installedPackage = path.join(
      installDir,
      "node_modules",
      "@clanker-stuff",
      "codex-provider"
    );
    expect(
      JSON.parse(
        readFileSync(path.join(installedPackage, "package.json"), "utf-8")
      )
    ).toMatchObject({
      name: "@clanker-stuff/codex-provider",
      peerDependencies: {
        "@earendil-works/pi-ai": "0.84.0",
        "@earendil-works/pi-coding-agent": "0.84.0",
        "@earendil-works/pi-tui": "0.84.0",
      },
      private: true,
    });
    const installed = await loadPackage(
      installedPackage,
      path.join(tempRoot, "runtime")
    );
    expect({
      errors: installed.errors,
      extensions: installed.extensions.map(({ resolvedPath }) =>
        path.relative(installedPackage, resolvedPath)
      ),
    }).toStrictEqual({
      errors: [],
      extensions: ["index.ts"],
    });
    expect(readdirSync(packDir)).toStrictEqual([filename]);
  }, 120_000);
});
