import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExtensionSmokeHarness } from "./harness/extension-smoke.js";
import type { ExtensionSmokeHarness } from "./harness/extension-smoke.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const EXTENSION_PACKAGES = [
  {
    commands: [],
    dir: "ask-question",
    handlers: [],
    name: "@clanker-extensions/ask-question",
    shortcuts: [],
    tools: ["ask_question"],
  },
  {
    commands: [],
    dir: "codex-reverse-i-search",
    handlers: ["input", "session_shutdown", "session_start", "user_bash"],
    name: "@clanker-extensions/codex-reverse-i-search",
    shortcuts: ["ctrl+r"],
    tools: [],
  },
  {
    commands: ["usage"],
    dir: "footer",
    handlers: [],
    name: "@clanker-extensions/footer",
    shortcuts: [],
    tools: [],
  },
  {
    commands: ["mcp"],
    dir: "mcp",
    handlers: [],
    name: "@clanker-extensions/mcp",
    shortcuts: [],
    tools: [],
  },
  {
    commands: [
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
    ],
    dir: "plannotator",
    handlers: [],
    name: "@clanker-extensions/plannotator",
    shortcuts: [],
    tools: [],
  },
  {
    commands: ["pop-stash"],
    dir: "stash",
    handlers: [],
    name: "@clanker-extensions/stash",
    shortcuts: ["ctrl+s"],
    tools: [],
  },
  {
    commands: [],
    dir: "timer",
    handlers: ["agent_start", "agent_settled"],
    name: "@clanker-extensions/timer",
    shortcuts: [],
    tools: [],
  },
  {
    commands: ["tools"],
    dir: "tool-picker",
    handlers: [],
    name: "@clanker-extensions/tool-picker",
    shortcuts: [],
    tools: [],
  },
] as const;

const packPackage = (tempRoot: string, packageName: string, dir: string) => {
  const packDir = path.join(tempRoot, "packs", dir);
  mkdirSync(packDir, { recursive: true });
  execFileSync(
    "pnpm",
    ["--filter", packageName, "pack", "--pack-destination", packDir],
    { cwd: REPO_ROOT, stdio: "pipe" }
  );
  const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one tarball for ${packageName}, found ${tarballs.length}`
    );
  }
  return path.join(packDir, tarballs[0]);
};

const inspectTarball = (packageName: string, tarball: string) => {
  const entries = execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf-8",
  }).split("\n");
  expect(entries, `${packageName} packed files`).toContain("package/LICENSE");

  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf-8",
    })
  ) as Record<string, Record<string, unknown> | undefined>;
  const workspaceDependencies = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(packageJson[field] ?? {}).flatMap(([name, version]) =>
      typeof version === "string" && version.startsWith("workspace:")
        ? [`${field}.${name}=${version}`]
        : []
    )
  );
  expect(workspaceDependencies, `${packageName} dependencies`).toStrictEqual(
    []
  );
};

describe("packed extension packages", () => {
  let harness: ExtensionSmokeHarness | undefined;
  let tempRoot: string | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("installs and loads every packed npm artifact", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "packed-extensions-smoke-"));
    const tarballs = EXTENSION_PACKAGES.map(({ dir, name }) => {
      const tarball = packPackage(tempRoot ?? "", name, dir);
      inspectTarball(name, tarball);
      return { name, tarball };
    });
    const installDir = path.join(tempRoot, "install");
    mkdirSync(installDir);
    writeFileSync(
      path.join(installDir, "package.json"),
      `${JSON.stringify(
        {
          dependencies: Object.fromEntries([
            ["@earendil-works/pi-ai", "0.81.0"],
            ["@earendil-works/pi-coding-agent", "0.81.0"],
            ["@earendil-works/pi-tui", "0.81.0"],
            ["typebox", "1.3.6"],
            ...tarballs.map(({ name, tarball }) => [name, `file:${tarball}`]),
          ]),
          private: true,
        },
        null,
        2
      )}\n`
    );
    const npmEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toLowerCase().startsWith("npm_config_")
      )
    );
    const emptyGlobalConfig = path.join(tempRoot, "empty-global.npmrc");
    const emptyUserConfig = path.join(tempRoot, "empty-user.npmrc");
    writeFileSync(emptyGlobalConfig, "");
    writeFileSync(emptyUserConfig, "");
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: installDir,
        env: {
          ...npmEnv,
          NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
          NPM_CONFIG_USERCONFIG: emptyUserConfig,
        },
        stdio: "pipe",
      }
    );

    const packageDirs = EXTENSION_PACKAGES.map(({ name }) =>
      path.join(installDir, "node_modules", ...name.split("/"))
    );

    harness = await createExtensionSmokeHarness({ packages: packageDirs });
    expect(harness.extensionsResult.errors).toStrictEqual([]);

    for (const [index, expected] of EXTENSION_PACKAGES.entries()) {
      const expectedEntryPath = path.join(packageDirs[index], "index.ts");
      const extension = harness.extensionsResult.extensions.find(
        ({ resolvedPath }) => resolvedPath === expectedEntryPath
      );
      if (extension === undefined) {
        throw new Error(`Packed extension did not load: ${expected.name}`);
      }

      for (const command of expected.commands) {
        expect(extension.commands.has(command)).toBeTruthy();
      }
      for (const handler of expected.handlers) {
        expect(extension.handlers.has(handler)).toBeTruthy();
      }
      for (const shortcut of expected.shortcuts) {
        expect(extension.shortcuts.has(shortcut)).toBeTruthy();
      }
      for (const tool of expected.tools) {
        expect(extension.tools.has(tool)).toBeTruthy();
      }
    }
  }, 120_000);
});
