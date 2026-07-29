import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost as createExtensionHostBase } from "../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../tests/harness/tui.js";
import { McpConfigSchema } from "../config.js";
import mcp from "../index.js";
import {
  PersistentMcpOAuthProvider,
  startOAuthCallbackServer,
} from "../oauth.js";
import {
  FIXTURE_ACCESS_TOKEN,
  startMcpHttpFixture,
} from "./fixtures/http-server.js";

const MCP_SERVER_FIXTURE = fileURLToPath(
  new URL("fixtures/server.ts", import.meta.url)
);

const fixtureServer = (scenario = "normal") => ({
  args: [MCP_SERVER_FIXTURE, scenario],
  command: process.execPath,
  type: "stdio" as const,
});

const envVarRef = (name: string, fallback?: string) =>
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

    Promise.resolve(
      factory(
        createMockTui(),
        createIdentityTheme(),
        {} as never,
        done as never
      )
    )
      .then((created) => {
        component = created as { dispose?: () => void };
      })
      .catch(reject);

    return await promise;
  } finally {
    component?.dispose?.();
  }
};

const createCustomStub = (): ExtensionCommandContext["ui"]["custom"] =>
  vi.fn<typeof runCustomStub>(
    runCustomStub
  ) as ExtensionCommandContext["ui"]["custom"];

// BorderedLoader's cancellable path formats a keybinding hint via the global
// theme singleton, which pi initializes at startup but tests do not.
initTheme("dark");

describe("mcp extension", () => {
  let homeDir: string;
  let projectDir: string;
  let configDir: string;
  let configPath: string;
  let localConfigPath: string;
  let previousAgentDir: string | undefined;
  let hosts: ReturnType<typeof createExtensionHostBase>[];
  let httpFixtures: { close: () => Promise<void> }[];

  const startHttpFixture = async (oauth = false, expireSessionOnce = false) => {
    const fixture = await startMcpHttpFixture(oauth, expireSessionOnce);
    httpFixtures.push(fixture);
    return fixture;
  };

  const createExtensionHost = (
    ...args: Parameters<typeof createExtensionHostBase>
  ) => {
    const host = createExtensionHostBase(...args);
    hosts.push(host);
    return host;
  };

  const writeConfig = async (value: unknown) => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(value)}\n`, "utf-8");
  };

  const writeLocalConfig = async (value: unknown) => {
    await mkdir(projectDir, { recursive: true });
    await writeFile(localConfigPath, `${JSON.stringify(value)}\n`, "utf-8");
  };

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random()}`;
    homeDir = path.join(tmpdir(), `pi-mcp-extension-${suffix}`);
    projectDir = path.join(tmpdir(), `pi-mcp-project-${suffix}`);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(homeDir, ".pi", "agent");
    configDir = path.join(homeDir, ".pi", "agent", "extensions");
    configPath = path.join(configDir, "mcp.json");
    localConfigPath = path.join(projectDir, ".mcp.json");
    hosts = [];
    httpFixtures = [];
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.emitSessionShutdown()));
    await Promise.all(httpFixtures.map((fixture) => fixture.close()));
    if (previousAgentDir === undefined) {
      Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(homeDir, { force: true, recursive: true });
    await rm(projectDir, { force: true, recursive: true });
  });

  describe(mcp, () => {
    it("registers the mcp command without session startup loading", async () => {
      await writeConfig({ invalid: true });
      const host = createExtensionHost(mcp);

      await host.ready;
      expect(host.getRegisteredCommands().get("mcp")).toMatchObject({
        description: "Load MCP server tools",
      });

      await host.emitSessionStart();

      expect(host.getNotifications()).toStrictEqual([]);
      expect(host.getRegisteredTools().size).toBe(0);
    });

    it("shows the built-in single-select list and does nothing when cancelled", async () => {
      await writeConfig({
        mcpServers: {
          github: { type: "http", url: "https://mcp.example.com" },
          local: { command: "/usr/bin/mcp-local", type: "stdio" },
        },
      });
      const host = createExtensionHost(mcp);
      const select = vi.fn<() => Promise<string | undefined>>(async () => {
        await Promise.resolve();
        return undefined as string | undefined;
      });
      const ctx = host.createContext({ ui: { select } });

      await host.runCommand("mcp", "", ctx);

      expect(select).toHaveBeenCalledWith("MCP server", ["github", "local"]);
      expect(host.getRegisteredTools().size).toBe(0);
    });

    it("loads project-local config from the command cwd", async () => {
      await writeLocalConfig({
        mcpServers: { project: fixtureServer() },
      });
      const select = vi.fn<() => Promise<string>>(async () => {
        await Promise.resolve();
        return "project";
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        cwd: projectDir,
        ui: { select },
      });

      await host.runCommand("mcp", "", ctx);

      expect(select).toHaveBeenCalledWith("MCP server", ["project"]);
      expect(host.getRegisteredTools().has("mcp_project__search")).toBeTruthy();
    });

    it("connects the selected server and registers its tools as active", async () => {
      await writeConfig({
        mcpServers: { github: fixtureServer() },
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        ui: {
          select: vi.fn<() => Promise<string>>(async () => {
            await Promise.resolve();
            return "github";
          }),
        },
      });

      await host.runCommand("mcp", "", ctx);
      const result = await host.runTool("mcp_github__search", {
        query: "needle",
      });

      expect(host.getActiveTools()).toContain("mcp_github__search");
      expect(host.getRegisteredTools().has("mcp_github__search")).toBeTruthy();
      expect(host.getNotifications()).toContainEqual({
        message: "MCP server github was loaded with 1 tools",
        type: undefined,
      });
      expect(result.content).toContainEqual({
        text: "result: needle",
        type: "text",
      });
    });

    it("loads tools from a real streamable HTTP server", async () => {
      const fixture = await startHttpFixture();
      await writeConfig({
        mcpServers: {
          remote: { type: "http", url: fixture.url },
        },
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        ui: {
          select: vi.fn<() => Promise<string>>(async () => "remote"),
        },
      });

      await host.runCommand("mcp", "", ctx);
      const result = await host.runTool("mcp_remote__search", {
        query: "http-needle",
      });

      expect(host.getRegisteredTools().has("mcp_remote__search")).toBeTruthy();
      expect(result.content).toContainEqual({
        text: "result: http-needle",
        type: "text",
      });
    });

    it("starts a new session after a session request receives HTTP 404", async () => {
      const fixture = await startHttpFixture(false, true);
      await writeConfig({
        mcpServers: {
          remote: { type: "http", url: fixture.url },
        },
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        ui: {
          select: vi.fn<() => Promise<string>>(async () => "remote"),
        },
      });

      await host.runCommand("mcp", "", ctx);

      const result = await host.runTool("mcp_remote__search", {
        query: "after-reconnect",
      });

      expect(result.content).toContainEqual({
        text: "result: after-reconnect",
        type: "text",
      });
      expect(fixture.getInitializationCount()).toBe(2);
    });

    it("completes OAuth after the user follows the displayed URL", async () => {
      const fixture = await startHttpFixture(true);
      await writeConfig({
        mcpServers: {
          remote: {
            oauth: { callbackPort: 33_420 },
            type: "http",
            url: fixture.url,
          },
        },
      });
      const select = vi.fn<() => Promise<string>>(async () => "remote");
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({ ui: { select } });

      const loading = host.runCommand("mcp", "", ctx);
      const authorizationUrl = await vi.waitFor(() => {
        const message = host.getNotifications().at(-1)?.message;
        if (message === undefined) {
          throw new Error("OAuth authorization URL was not shown");
        }
        expect(message).toMatch(
          /^Authorize MCP server remote:\nhttps?:\/\/.+\nWaiting for OAuth authorization\.\.\.$/u
        );
        return message.split("\n")[1];
      });
      await fetch(authorizationUrl);
      await loading;

      const result = await host.runTool("mcp_remote__search", {
        query: "oauth-needle",
      });
      expect(result.content).toContainEqual({
        text: "result: oauth-needle",
        type: "text",
      });
      expect(
        JSON.parse(
          await readFile(path.join(configDir, "mcp-oauth.json"), "utf-8")
        )
      ).toMatchObject({
        servers: {
          remote: {
            clientInformation: { client_id: "fixture-client-id" },
            tokens: { access_token: FIXTURE_ACCESS_TOKEN },
          },
        },
      });
    });

    it("truncates large tool results and keeps compact details", async () => {
      await writeConfig({
        mcpServers: { github: fixtureServer("large") },
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        ui: {
          select: vi.fn<() => Promise<string>>(async () => "github"),
        },
      });
      await host.runCommand("mcp", "", ctx);

      const result = await host.runTool("mcp_github__search", {
        query: "anything",
      });

      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("[MCP output truncated:"),
        type: "text",
      });
      expect(result.details).toStrictEqual({
        serverName: "github",
        toolName: "search",
        truncated: true,
      });
      expect(JSON.stringify(result)).not.toContain("mcpResult");
    });

    it("rejects generated tool-name collisions", async () => {
      await writeConfig({
        mcpServers: { github: fixtureServer("collision") },
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        ui: {
          select: vi.fn<() => Promise<string>>(async () => "github"),
        },
      });

      await host.runCommand("mcp", "", ctx);

      expect(host.getRegisteredTools().size).toBe(0);
      expect(host.getNotifications()).toContainEqual({
        message: expect.stringContaining("MCP tool name collision"),
        type: "error",
      });
    });

    it("uses custom UI while loading a selected server when interactive", async () => {
      await writeConfig({
        mcpServers: { github: fixtureServer() },
      });
      const host = createExtensionHost(mcp);
      const custom = createCustomStub();
      const ctx = host.createContext({
        ui: {
          custom,
          select: vi.fn<() => Promise<string>>(async () => {
            await Promise.resolve();
            return "github";
          }),
        },
      });

      await host.runCommand("mcp", "", ctx);

      expect(custom).toHaveBeenCalledOnce();
      expect(host.getRegisteredTools().has("mcp_github__search")).toBeTruthy();
    });

    it("reports an empty MCP config without opening the selector", async () => {
      await writeConfig({ mcpServers: {} });
      const host = createExtensionHost(mcp);
      const select = vi.fn<() => Promise<string | undefined>>(async () => {
        await Promise.resolve();
        return undefined as string | undefined;
      });
      const ctx = host.createContext({ ui: { select } });

      await host.runCommand("mcp", "", ctx);

      expect(select).not.toHaveBeenCalled();
      expect(host.getNotifications()).toContainEqual({
        message: "No MCP servers configured.",
        type: "info",
      });
    });

    it("persists loaded server state to session entries", async () => {
      await writeConfig({
        mcpServers: { github: fixtureServer() },
      });
      const host = createExtensionHost(mcp, { hasUI: false });
      const ctx = host.createContext({
        ui: {
          select: vi.fn<() => Promise<string>>(async () => {
            await Promise.resolve();
            return "github";
          }),
        },
      });

      await host.runCommand("mcp", "", ctx);

      const mcpEntries = host
        .getAppendedEntries()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "mcp-server-loaded"
        );
      expect(mcpEntries).toHaveLength(1);
      const { data } = mcpEntries[0] as { data: unknown };
      expect(data).toStrictEqual({
        serverName: "github",
      });
    });

    it("auto-reconnects persisted servers on session_start", async () => {
      await writeConfig({
        mcpServers: { github: fixtureServer() },
      });

      const persistedEntry = {
        customType: "mcp-server-loaded",
        data: {
          serverName: "github",
        },
        id: "persisted-load-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        type: "custom",
      };

      const host = createExtensionHost(mcp, {
        entries: [persistedEntry as never],
        hasUI: false,
        leafId: "persisted-load-entry",
      });

      await host.ready;
      await host.emitSessionStart();

      expect(host.getRegisteredTools().has("mcp_github__search")).toBeTruthy();
      expect(host.getActiveTools()).toContain("mcp_github__search");
    });
  });

  describe("MCP config schema validation", () => {
    it("accepts http server config", () => {
      const config = {
        mcpServers: {
          github: {
            headers: { Authorization: "Bearer token" },
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
          },
        },
      };
      expect(Value.Check(McpConfigSchema, config)).toBeTruthy();
    });

    it("accepts OAuth http server config", () => {
      expect(
        Value.Check(McpConfigSchema, {
          mcpServers: {
            interactive: {
              oauth: {
                authServerMetadataUrl:
                  "https://auth.example.com/.well-known/openid-configuration",
                callbackPort: 33_418,
                clientId: "client-id",
                clientName: "pi MCP",
                scopes: "tools",
              },
              type: "http",
              url: "https://mcp.example.com",
            },
            machine: {
              oauth: {
                clientId: "client-id",
                clientSecret: "client-secret",
              },
              type: "streamable-http",
              url: "https://machine.example.com",
            },
          },
        })
      ).toBeTruthy();
    });

    it("accepts stdio server config", () => {
      const config = {
        mcpServers: {
          "local-db": {
            args: ["--port", "8080"],
            command: "/usr/local/bin/db-server",
            env: { DB_URL: "postgresql://..." },
            type: "stdio",
          },
        },
      };
      expect(Value.Check(McpConfigSchema, config)).toBeTruthy();
    });

    it("rejects unknown server config fields", () => {
      expect(
        Value.Check(McpConfigSchema, {
          mcpServers: {
            api: {
              extra: true,
              type: "http",
              url: "https://mcp.example.com",
            },
          },
        })
      ).toBeFalsy();
      expect(
        Value.Check(McpConfigSchema, {
          mcpServers: {
            local: {
              command: "/usr/bin/mcp-local",
              extra: true,
              type: "stdio",
            },
          },
        })
      ).toBeFalsy();
    });
  });

  describe("loadMcpConfig", () => {
    it("loads a project-local .mcp.json when global config is missing", async () => {
      const { loadMcpConfig } = await import("../config.js");
      await writeLocalConfig({
        mcpServers: {
          project: {
            oauth: {},
            type: "streamable-http",
            url: "https://project.example.com/mcp",
          },
        },
      });

      await expect(
        loadMcpConfig({ cwd: projectDir, projectTrusted: true })
      ).resolves.toStrictEqual({
        mcpServers: {
          project: {
            oauth: {},
            type: "streamable-http",
            url: "https://project.example.com/mcp",
          },
        },
      });
    });

    it("merges global and project-local servers with local taking precedence", async () => {
      const { loadMcpConfig } = await import("../config.js");
      await writeConfig({
        mcpServers: {
          global: { type: "http", url: "https://global.example.com" },
          shared: { type: "http", url: "https://old.example.com" },
        },
      });
      await writeLocalConfig({
        mcpServers: {
          project: { command: "/usr/bin/project-mcp", type: "stdio" },
          shared: { type: "http", url: "https://new.example.com" },
        },
      });

      await expect(
        loadMcpConfig({ cwd: projectDir, projectTrusted: true })
      ).resolves.toStrictEqual({
        mcpServers: {
          global: { type: "http", url: "https://global.example.com" },
          project: { command: "/usr/bin/project-mcp", type: "stdio" },
          shared: { type: "http", url: "https://new.example.com" },
        },
      });
    });

    it("ignores project-local config when the project is untrusted", async () => {
      const { loadMcpConfig } = await import("../config.js");
      await writeConfig({
        mcpServers: {
          global: { type: "http", url: "https://global.example.com" },
        },
      });
      await writeLocalConfig({
        mcpServers: {
          local: { command: "/tmp/untrusted", type: "stdio" },
        },
      });

      await expect(
        loadMcpConfig({ cwd: projectDir, projectTrusted: false })
      ).resolves.toStrictEqual({
        mcpServers: {
          global: { type: "http", url: "https://global.example.com" },
        },
      });
    });

    it("rejects invalid project-local config", async () => {
      const { loadMcpConfig } = await import("../config.js");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        localConfigPath,
        JSON.stringify({ mcpServers: { bad: { type: "stdio" } } }),
        "utf-8"
      );

      await expect(
        loadMcpConfig({ cwd: projectDir, projectTrusted: true })
      ).rejects.toThrow(/invalid config .*\.mcp\.json/u);
    });

    it("expands Claude-style environment variables", async () => {
      process.env.MCP_TEST_COMMAND = "/usr/bin/test-mcp";
      process.env.MCP_TEST_TOKEN = "secret-token";
      process.env.MCP_TEST_BASE_URL = "https://api.example.com";
      const { loadMcpConfig } = await import("../config.js");
      await writeConfig({
        mcpServers: {
          local: {
            args: ["--cache", envVarRef("MCP_TEST_CACHE", "/tmp/cache")],
            command: envVarRef("MCP_TEST_COMMAND"),
            env: { API_TOKEN: envVarRef("MCP_TEST_TOKEN") },
            type: "stdio",
          },
          remote: {
            headers: {
              Authorization: `Bearer ${envVarRef("MCP_TEST_TOKEN")}`,
            },
            type: "http",
            url: `${envVarRef("MCP_TEST_BASE_URL")}/mcp`,
          },
        },
      });

      await expect(loadMcpConfig()).resolves.toStrictEqual({
        mcpServers: {
          local: {
            args: ["--cache", "/tmp/cache"],
            command: "/usr/bin/test-mcp",
            env: { API_TOKEN: "secret-token" },
            type: "stdio",
          },
          remote: {
            headers: { Authorization: "Bearer secret-token" },
            type: "http",
            url: "https://api.example.com/mcp",
          },
        },
      });

      Reflect.deleteProperty(process.env, "MCP_TEST_COMMAND");
      Reflect.deleteProperty(process.env, "MCP_TEST_TOKEN");
      Reflect.deleteProperty(process.env, "MCP_TEST_BASE_URL");
    });

    it("reports missing environment variables", async () => {
      const { loadMcpConfig } = await import("../config.js");
      await writeConfig({
        mcpServers: {
          remote: {
            headers: {
              Authorization: `Bearer ${envVarRef("MCP_TEST_MISSING_TOKEN")}`,
            },
            type: "http",
            url: "https://api.example.com/mcp",
          },
        },
      });

      await expect(loadMcpConfig()).rejects.toThrow(
        "missing environment variable in MCP config: MCP_TEST_MISSING_TOKEN"
      );
    });
  });

  describe(PersistentMcpOAuthProvider, () => {
    it("maps Claude-shaped OAuth config to the provider", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        {
          callbackPort: 33_419,
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: "tools resources",
        },
        vi.fn<() => void>()
      );

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "client-id",
        client_secret: "client-secret",
      });
      expect(provider.clientMetadata.scope).toBe("tools resources");
      expect(provider.redirectUrl.toString()).toBe(
        "http://localhost:33419/callback"
      );
    });

    it("persists dynamic client information and tokens per server", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );

      await provider.saveClientInformation({ client_id: "dynamic-client" });
      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      });

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "dynamic-client",
      });
      await expect(provider.tokens()).resolves.toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
      expect(
        JSON.parse(
          await readFile(path.join(configDir, "mcp-oauth.json"), "utf-8")
        )
      ).toMatchObject({
        servers: {
          remote: {
            clientInformation: { client_id: "dynamic-client" },
            tokens: { access_token: "access-token" },
          },
        },
      });
    });

    it("round-trips the SEP-2352 issuer stamp on stored credentials", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );

      // saveClientInformation then saveTokens mirrors the SDK auth flow; the
      // second save must not strip the issuer stamp from clientInformation.
      await provider.saveClientInformation({
        client_id: "dynamic-client",
        issuer: "https://auth.example.com",
      });
      await provider.saveTokens({
        access_token: "access-token",
        issuer: "https://auth.example.com",
        token_type: "Bearer",
      });

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "dynamic-client",
        issuer: "https://auth.example.com",
      });
      await expect(provider.tokens()).resolves.toStrictEqual({
        access_token: "access-token",
        issuer: "https://auth.example.com",
        token_type: "Bearer",
      });
    });

    it("clears only tokens on the tokens scope", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );
      await provider.saveClientInformation({ client_id: "dynamic-client" });
      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      });
      await provider.saveCodeVerifier("verifier");

      await provider.invalidateCredentials("tokens");

      await expect(provider.tokens()).resolves.toBeUndefined();
      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "dynamic-client",
      });
      await expect(provider.codeVerifier()).resolves.toBe("verifier");
    });

    it("clears all stored credentials on the all scope", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );
      await provider.saveClientInformation({ client_id: "dynamic-client" });
      await provider.saveTokens({
        access_token: "access-token",
        token_type: "Bearer",
      });
      await provider.saveCodeVerifier("verifier");
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
      });

      await provider.invalidateCredentials("all");

      await expect(provider.clientInformation()).resolves.toBeUndefined();
      await expect(provider.tokens()).resolves.toBeUndefined();
      await expect(provider.codeVerifier()).rejects.toThrow(
        "No MCP OAuth code verifier saved"
      );
      await expect(provider.discoveryState()).resolves.toBeUndefined();
    });

    it("keeps static-config client credentials on invalidation", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { clientId: "static-client", scopes: "tools" },
        vi.fn<() => void>()
      );

      await provider.invalidateCredentials("all");

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "static-client",
        client_secret: undefined,
      });
    });

    it("rejects malformed persisted OAuth state", async () => {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, "mcp-oauth.json"),
        '{"servers":null}\n',
        "utf-8"
      );
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );

      await expect(provider.tokens()).rejects.toThrow(
        "invalid MCP OAuth state"
      );

      await writeFile(
        path.join(configDir, "mcp-oauth.json"),
        '{"servers":{"remote":{"tokens":{"access_token":42}}}}\n',
        "utf-8"
      );
      await expect(provider.tokens()).rejects.toThrow(
        "invalid MCP OAuth state"
      );
    });
  });

  describe(startOAuthCallbackServer, () => {
    it("rejects waitForCode when the abort signal fires", async () => {
      const server = await startOAuthCallbackServer(
        new URL("http://localhost:0/callback"),
        "expected-state"
      );
      try {
        const controller = new AbortController();
        const wait = server.waitForCode(controller.signal);
        controller.abort();
        await expect(wait).rejects.toThrow(
          "MCP OAuth authorization was cancelled"
        );
      } finally {
        await server.close();
      }
    });
    it("rejects cleanly when the callback port is already in use", async () => {
      const squatter = createServer();
      squatter.listen(0, "localhost");
      await once(squatter, "listening");
      const { port } = squatter.address() as { port: number };
      try {
        await expect(
          startOAuthCallbackServer(
            new URL(`http://localhost:${port}/callback`),
            "expected-state"
          )
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
      } finally {
        squatter.close();
        await once(squatter, "close");
      }
    });
  });
});
