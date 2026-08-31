import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SUPPORTED_PI_VERSION } from "../audit-local-order.js";
import { CHECKPOINT_CUSTOM_TYPE } from "../checkpoint.js";
import * as packageEntry from "../index.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const SUBAGENTS_ROOT = path.resolve(PACKAGE_ROOT, "../subagents");
const EXPECTED_ENTRY = path.join(PACKAGE_ROOT, "index.ts");
const EXPECTED_SUBAGENTS_ENTRY = path.join(SUBAGENTS_ROOT, "index.ts");
const SENSITIVE_HOOKS = [
  "before_agent_start",
  "context",
  "before_provider_headers",
  "before_provider_request",
  "session_before_compact",
  "session_compact_failed",
] as const;
const CODEX_TOOLS = [
  "exec_command",
  "write_stdin",
  "apply_patch",
  "view_image",
  "exec",
  "wait",
] as const;
const COLLABORATION_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
] as const;
const NPM_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
);

const loadPackages = async (packageRoots: string[], rootDir: string) => {
  const settingsManager = SettingsManager.inMemory({
    packages: packageRoots,
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
    const result = await loadPackages([PACKAGE_ROOT], tempRoot);
    const extension = result.extensions.find(({ resolvedPath }) => resolvedPath === EXPECTED_ENTRY);

    expect({
      commands: ["code-mode", "codex-provider", "fast", "ultra"].filter((command) =>
        extension?.commands.has(command),
      ),
      entryRenderer: extension?.entryRenderers?.has(CHECKPOINT_CUSTOM_TYPE),
      errors: result.errors,
      exports: Object.keys(packageEntry),
      fastFlag: extension?.flags.has("fast"),
      ultraFlag: extension?.flags.has("ultra"),
      sensitiveHooks: SENSITIVE_HOOKS.filter((hook) => extension?.handlers.has(hook)),
      tools: CODEX_TOOLS.filter((tool) => extension?.tools.has(tool)),
    }).toStrictEqual({
      commands: ["code-mode", "codex-provider", "fast", "ultra"],
      entryRenderer: true,
      errors: [],
      exports: ["default"],
      fastFlag: true,
      ultraFlag: true,
      sensitiveHooks: [...SENSITIVE_HOOKS],
      tools: [...CODEX_TOOLS],
    });
    expect(
      existsSync(path.join(agentDir, "data", "codex-provider", "codex-provider.sqlite")),
    ).toBeFalsy();
  });

  it("discovers cleanly after the companion subagents extension", async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "codex-package-coload-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(tempRoot, "agent"));
    const result = await loadPackages([SUBAGENTS_ROOT, PACKAGE_ROOT], tempRoot);
    const provider = result.extensions.find(({ resolvedPath }) => resolvedPath === EXPECTED_ENTRY);
    const subagents = result.extensions.find(
      ({ resolvedPath }) => resolvedPath === EXPECTED_SUBAGENTS_ENTRY,
    );

    expect({
      errors: result.errors,
      order: result.extensions.map(({ resolvedPath }) => resolvedPath),
      providerCollaboration: COLLABORATION_TOOLS.filter((name) => provider?.tools.has(name)),
      subagentsCommand: subagents?.commands.has("agents"),
    }).toStrictEqual({
      errors: [],
      order: [EXPECTED_SUBAGENTS_ENTRY, EXPECTED_ENTRY],
      providerCollaboration: [],
      subagentsCommand: true,
    });
  });

  it("packs, installs, and loads with production peer resolution", async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "codex-package-pack-"));
    const tarball = path.join(tempRoot, "codex-provider.tgz");
    execFileSync("pnpm", ["pack", "--out", tarball], {
      cwd: PACKAGE_ROOT,
      env: NPM_ENV,
      stdio: "pipe",
    });
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
        "package/checkpoint-marker.ts",
        "package/checkpoint.ts",
        "package/code-mode/LICENSE.howaboua",
        "package/code-mode/LICENSE.openai",
        "package/code-mode/NOTICE",
        "package/code-mode/UPSTREAM",
        "package/code-mode/binary.ts",
        "package/code-mode/delegate-runtime.ts",
        "package/code-mode/host-assets.ts",
        "package/code-mode/host-client.ts",
        "package/code-mode/install-host.ts",
        "package/code-mode/protocol.ts",
        "package/code-mode/tools.ts",
        "package/code-mode/trace-store.ts",
        "package/code-mode/trace-values.ts",
        "package/code-mode/types.ts",
        "package/collaboration.ts",
        "package/fast-mode.ts",
        "package/docs/codex-baseline.md",
        "package/docs/context-alignment.md",
        "package/docs/design.md",
        "package/docs/evaluation.md",
        "package/docs/live-canary.md",
        "package/docs/local-deployment.md",
        "package/docs/ultra.md",
        "package/footer.ts",
        "package/index.ts",
        "package/lazy-provider.ts",
        "package/lifecycle.ts",
        "package/model-catalog.ts",
        "package/observability.ts",
        "package/package.json",
        "package/provider.ts",
        "package/renderer.ts",
        "package/replay.ts",
        "package/runtime.ts",
        "package/skill-catalog.ts",
        "package/status.ts",
        "package/tools/controller.ts",
        "package/tools/direct.ts",
        "package/tools/patch.ts",
        "package/tools/path.ts",
        "package/tools/process-output.ts",
        "package/tools/process.ts",
        "package/tools/register.ts",
        "package/tools/selection.ts",
        "package/ultra/index.ts",
      ].toSorted(),
    );
    const installDir = path.join(tempRoot, "install");
    mkdirSync(installDir);
    writeFileSync(
      path.join(installDir, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "@clanker-stuff/codex-provider": `file:${tarball}`,
            "@clanker-stuff/footer-protocol": `file:${path.resolve(
              PACKAGE_ROOT,
              "../../../packages/footer-protocol",
            )}`,
            "@clanker-stuff/lazy-singleton": `file:${path.resolve(
              PACKAGE_ROOT,
              "../../../packages/lazy-singleton",
            )}`,
            "@clanker-stuff/pi-extension-paths": `file:${path.resolve(
              PACKAGE_ROOT,
              "../../../packages/extension-paths",
            )}`,
            "@clanker-stuff/tool-owner-protocol": `file:${path.resolve(
              PACKAGE_ROOT,
              "../../../packages/tool-owner-protocol",
            )}`,
            "@earendil-works/pi-ai": SUPPORTED_PI_VERSION,
            "@earendil-works/pi-coding-agent": SUPPORTED_PI_VERSION,
            "@earendil-works/pi-tui": SUPPORTED_PI_VERSION,
            typebox: "1.3.7",
          },
          private: true,
        },
        null,
        2,
      )}\n`,
    );
    execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: installDir,
      env: NPM_ENV,
      stdio: "pipe",
    });
    const installedPackage = path.join(
      installDir,
      "node_modules",
      "@clanker-stuff",
      "codex-provider",
    );
    expect(
      JSON.parse(readFileSync(path.join(installedPackage, "package.json"), "utf-8")),
    ).toMatchObject({
      dependencies: {
        "@clanker-stuff/footer-protocol": "^0.1.0",
        "@clanker-stuff/lazy-singleton": "^0.1.0",
        "@clanker-stuff/pi-extension-paths": "^0.1.0",
        "@clanker-stuff/tool-owner-protocol": "^0.1.0",
      },
      name: "@clanker-stuff/codex-provider",
      peerDependencies: {
        "@earendil-works/pi-ai": "*",
        "@earendil-works/pi-coding-agent": "*",
        "@earendil-works/pi-tui": "*",
        typebox: "*",
      },
      private: true,
    });
    const installed = await loadPackages([installedPackage], path.join(tempRoot, "runtime"));
    expect({
      errors: installed.errors,
      extensions: installed.extensions.map(({ resolvedPath }) =>
        path.relative(installedPackage, resolvedPath),
      ),
    }).toStrictEqual({
      errors: [],
      extensions: ["index.ts"],
    });
  }, 120_000);
});
