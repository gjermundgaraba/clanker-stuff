import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { createExtensionHost as createExtensionHostBase } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createMockTui,
} from "../../../tests/harness/tui.js";
import mcp from "../index.js";
import { MCP_MANAGER_SERVER_NAME } from "../manager.js";
import { startMcpHttpFixture } from "./fixtures/http-server.js";

const MCP_SERVER_FIXTURE = fileURLToPath(
  new URL("fixtures/server.ts", import.meta.url)
);

export const fixtureServer = (scenario = "normal") => ({
  args: [MCP_SERVER_FIXTURE, scenario],
  command: process.execPath,
  type: "stdio" as const,
});

export const envVarRef = (name: string, fallback?: string) =>
  fallback === undefined ? `\${${name}}` : `\${${name}:-${fallback}}`;

const runCustomStub = async <T>(
  factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]
): Promise<T> => {
  let component: { dispose?: () => void } | undefined;
  const { promise, reject, resolve } = Promise.withResolvers<T>();
  try {
    const done = (result: T) => {
      component?.dispose?.();
      resolve(result);
    };

    void (async () => {
      try {
        component = (await factory(
          createMockTui(),
          createIdentityTheme(),
          {} as never,
          done as never
        )) as { dispose?: () => void };
      } catch (error) {
        reject(error);
      }
    })();

    return await promise;
  } finally {
    component?.dispose?.();
  }
};

export const createCustomStub = (): ExtensionCommandContext["ui"]["custom"] =>
  vi.fn<typeof runCustomStub>(
    runCustomStub
  ) as ExtensionCommandContext["ui"]["custom"];

// BorderedLoader's cancellable path formats a keybinding hint via the global
// theme singleton, which pi initializes at startup but tests do not.
initTheme("dark");

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
};

// Registers beforeEach/afterEach hooks for the calling test file: isolated
// config directories, host shutdown, and HTTP fixture cleanup.
export const setupMcpTest = () => {
  const state = {
    configPath: "",
    dataDir: "",
    homeDir: "",
    hosts: [] as ReturnType<typeof createExtensionHostBase>[],
    httpFixtures: [] as { close: () => Promise<void> }[],
    localConfigPath: "",
    previousAgentDir: undefined as string | undefined,
    projectDir: "",
  };

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random()}`;
    state.homeDir = path.join(tmpdir(), `pi-mcp-extension-${suffix}`);
    state.projectDir = path.join(tmpdir(), `pi-mcp-project-${suffix}`);
    state.previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(state.homeDir, ".pi", "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    state.configPath = path.join(agentDir, "mcp.json");
    state.dataDir = path.join(agentDir, "data", "mcp");
    state.localConfigPath = path.join(state.projectDir, ".pi", "mcp.json");
    state.hosts = [];
    state.httpFixtures = [];
  });

  afterEach(async () => {
    await Promise.all(state.hosts.map((host) => host.emitSessionShutdown()));
    await Promise.all(state.httpFixtures.map((fixture) => fixture.close()));
    if (state.previousAgentDir === undefined) {
      Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    } else {
      process.env.PI_CODING_AGENT_DIR = state.previousAgentDir;
    }
    await rm(state.homeDir, { force: true, recursive: true });
    await rm(state.projectDir, { force: true, recursive: true });
  });

  const createExtensionHost = (
    ...args: Parameters<typeof createExtensionHostBase>
  ) => {
    const host = createExtensionHostBase(...args);
    state.hosts.push(host);
    return host;
  };

  const startHttpFixture = async (
    oauth = false,
    expireSessionOnce = false,
    pauseInitialization = false
  ) => {
    const fixture = await startMcpHttpFixture(
      oauth,
      expireSessionOnce,
      pauseInitialization
    );
    state.httpFixtures.push(fixture);
    return fixture;
  };

  const writeConfig = async (value: unknown) => {
    await writeJson(state.configPath, value);
  };

  const writeLocalConfig = async (value: unknown) => {
    await writeJson(state.localConfigPath, value);
  };

  const loadManager = async (
    options: { cwd?: string; projectTrusted?: boolean } = {}
  ) => {
    const host = createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({
      cwd: options.cwd ?? process.cwd(),
      isProjectTrusted: vi.fn<() => boolean>(
        () => options.projectTrusted ?? true
      ),
      ui: {
        select: vi.fn<() => Promise<string>>(
          async () => `○ ${MCP_MANAGER_SERVER_NAME}`
        ),
      },
    });
    expect(host.getRegisteredTools().size).toBe(0);
    await host.runCommand("mcp", "", ctx);
    return host;
  };

  return {
    get configPath() {
      return state.configPath;
    },
    createExtensionHost,
    get dataDir() {
      return state.dataDir;
    },
    loadManager,
    get localConfigPath() {
      return state.localConfigPath;
    },
    get projectDir() {
      return state.projectDir;
    },
    startHttpFixture,
    writeConfig,
    writeLocalConfig,
  };
};
