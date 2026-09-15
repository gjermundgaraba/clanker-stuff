import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  setMcpServer,
  resolveMcpServer,
  listMcpServers,
  loadMcpConfig,
  ServerConfigSchema,
  removeMcpServer,
} from "../config.js";
import { envVarRef, setupMcpTest } from "./helpers.js";

describe("MCP config schema validation", () => {
  it.each([
    { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } },
    {
      type: "http",
      url: "https://example.com/mcp",
      oauth: {
        authServerMetadataUrl: "https://example.com/metadata",
        callbackPort: 33418,
        clientId: "client",
        clientSecret: "secret",
        clientName: "pi MCP",
        scopes: "tools",
      },
    },
    { type: "stdio", command: "mcp-server", args: ["--port", "8080"], env: { TOKEN: "token" } },
    {
      type: "http",
      url: "https://example.com/mcp",
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000,
    },
    { type: "stdio", command: "mcp-server", heartbeatIntervalMs: 0 },
  ])("accepts $type server configuration", (server) => {
    expect(Value.Check(ServerConfigSchema, server)).toBe(true);
    expect(Value.Check(ServerConfigSchema, { ...server, extra: true })).toBe(false);
  });

  it.each([
    { heartbeatIntervalMs: -1 },
    { heartbeatIntervalMs: 1.5 },
    { heartbeatIntervalMs: 2_147_483_648 },
    { heartbeatTimeoutMs: 0 },
    { heartbeatTimeoutMs: -1 },
    { heartbeatTimeoutMs: "1000" },
  ])("rejects invalid heartbeat settings: %j", (settings) => {
    expect(
      Value.Check(ServerConfigSchema, { type: "http", url: "https://example.com", ...settings }),
    ).toBe(false);
  });
});

describe(resolveMcpServer, () => {
  it("reports a missing selected server", () => {
    expect(() => resolveMcpServer({ mcpServers: {} }, "missing")).toThrow(
      "MCP server missing is not configured",
    );
  });

  it("preserves absent OAuth keys and does not mutate the source", () => {
    const oauth = { callbackPort: 33418 };
    const config = {
      mcpServers: { remote: { type: "http", url: "https://example.com", oauth } },
    };
    expect(resolveMcpServer(config, "remote")).toStrictEqual({
      type: "http",
      url: "https://example.com",
      headers: undefined,
      oauth: { callbackPort: 33418 },
    });
    expect(oauth).toStrictEqual({ callbackPort: 33418 });
  });

  it.each(["url", "authServerMetadataUrl"])("checks the expanded %s URL scheme", (field) => {
    vi.stubEnv("MCP_TEST_BAD_URL", "file:///tmp/mcp");
    const config = {
      mcpServers: {
        remote: {
          type: "http",
          url: field === "url" ? envVarRef("MCP_TEST_BAD_URL") : "https://example.com",
          oauth:
            field === "authServerMetadataUrl"
              ? { authServerMetadataUrl: envVarRef("MCP_TEST_BAD_URL") }
              : {},
        },
      },
    };
    try {
      expect(() => resolveMcpServer(config, "remote")).toThrow("MCP URLs must use HTTP or HTTPS");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe(loadMcpConfig, () => {
  const t = setupMcpTest();

  it("normalizes a missing server map and preserves unrelated document fields", async () => {
    await t.writeConfig({ note: "keep" });
    expect(await loadMcpConfig()).toEqual({ mcpServers: {} });
    await setMcpServer("remote", { type: "stdio", command: "first", args: ["old"] }, "global", {});
    await setMcpServer("remote", { type: "stdio", command: "replacement" }, "global", {});
    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toEqual({
      note: "keep",
      mcpServers: { remote: { type: "stdio", command: "replacement" } },
    });
  });

  it.each([null, [], { mcpServers: null }, { mcpServers: [] }, { mcpServers: 1 }])(
    "rejects an invalid document: %j",
    async (document) => {
      await t.writeConfig(document);
      await expect(loadMcpConfig()).rejects.toThrow("invalid config");
    },
  );

  it("rejects malformed JSON", async () => {
    await t.writeConfig({});
    await writeFile(t.configPath, "{broken");
    await expect(loadMcpConfig()).rejects.toThrow();
  });

  it("removing an absent server neither creates nor rewrites configuration", async () => {
    await removeMcpServer("absent", "global", {});
    await expect(stat(t.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await t.writeConfig({ note: "keep" });
    const before = await stat(t.configPath);
    await removeMcpServer("absent", "global", {});
    expect((await stat(t.configPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(t.configPath, "utf-8")).toBe('{"note":"keep"}\n');
  });

  it("does not mutate configuration after cancellation while queued", async () => {
    await t.writeConfig({ mcpServers: {} });
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = withFileMutationQueue(t.configPath, async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const controller = new AbortController();
    const mutation = setMcpServer(
      "canceled",
      { type: "stdio", command: "fixture" },
      "global",
      {},
      controller.signal,
    );
    controller.abort();
    release.resolve();
    await blocker;
    await expect(mutation).rejects.toMatchObject({ name: "AbortError" });
    expect(await loadMcpConfig()).toEqual({ mcpServers: {} });
  });

  it("preserves malformed entries and unknown document fields during concurrent mutations", async () => {
    await t.writeConfig({ note: "keep me", mcpServers: { broken: { type: "future" } } });
    await Promise.all(
      ["one", "two", "three"].map((name) =>
        setMcpServer(name, { type: "stdio", command: "fixture" }, "global", {}),
      ),
    );
    expect(JSON.parse(await readFile(t.configPath, "utf-8"))).toEqual({
      note: "keep me",
      mcpServers: {
        broken: { type: "future" },
        one: { type: "stdio", command: "fixture" },
        two: { type: "stdio", command: "fixture" },
        three: { type: "stdio", command: "fixture" },
      },
    });
    expect(await listMcpServers({})).toContainEqual({
      name: "broken",
      scope: "global",
      error: "Invalid server configuration",
    });
    await removeMcpServer("broken", "global", {});
    expect(await listMcpServers({})).toHaveLength(3);
  });

  it("loads project-local .pi/mcp.json when global config is missing", async () => {
    await t.writeLocalConfig({
      mcpServers: {
        project: {
          oauth: {},
          type: "http",
          url: "https://project.example.com/mcp",
        },
      },
    });

    await expect(loadMcpConfig({ cwd: t.projectDir, projectTrusted: true })).resolves.toStrictEqual(
      {
        mcpServers: {
          project: {
            oauth: {},
            type: "http",
            url: "https://project.example.com/mcp",
          },
        },
      },
    );
  });

  it("merges global and project-local servers with local taking precedence", async () => {
    await t.writeConfig({
      mcpServers: {
        global: { type: "http", url: "https://global.example.com" },
        shared: { type: "http", url: "https://old.example.com" },
      },
    });
    await t.writeLocalConfig({
      mcpServers: {
        project: { command: "/usr/bin/project-mcp", type: "stdio" },
        shared: { type: "http", url: "https://new.example.com" },
      },
    });

    await expect(loadMcpConfig({ cwd: t.projectDir, projectTrusted: true })).resolves.toStrictEqual(
      {
        mcpServers: {
          global: { type: "http", url: "https://global.example.com" },
          project: { command: "/usr/bin/project-mcp", type: "stdio" },
          shared: { type: "http", url: "https://new.example.com" },
        },
      },
    );
    await expect(
      listMcpServers({ cwd: t.projectDir, projectTrusted: true }),
    ).resolves.toStrictEqual([
      { name: "global", scope: "global" },
      { name: "shared", scope: "project" },
      { name: "project", scope: "project" },
    ]);
  });

  it("ignores project-local config when the project is untrusted", async () => {
    await t.writeConfig({
      mcpServers: {
        global: { type: "http", url: "https://global.example.com" },
      },
    });
    await t.writeLocalConfig({
      mcpServers: {
        local: { command: "/tmp/untrusted", type: "stdio" },
      },
    });

    await expect(
      loadMcpConfig({ cwd: t.projectDir, projectTrusted: false }),
    ).resolves.toStrictEqual({
      mcpServers: {
        global: { type: "http", url: "https://global.example.com" },
      },
    });
  });

  it("isolates invalid entries and permits removing them", async () => {
    await mkdir(path.dirname(t.localConfigPath), { recursive: true });
    await writeFile(
      t.localConfigPath,
      JSON.stringify({ mcpServers: { bad: { type: "stdio" } } }),
      "utf-8",
    );

    const options = { cwd: t.projectDir, projectTrusted: true };
    const config = await loadMcpConfig(options);
    expect(() => resolveMcpServer(config, "bad")).toThrow("Invalid MCP server");
    expect(await listMcpServers(options)).toEqual([
      { name: "bad", scope: "project", error: "Invalid server configuration" },
    ]);
    await removeMcpServer("bad", "project", options);
    expect(await listMcpServers(options)).toEqual([]);
  });

  it("expands Claude-style environment variables for a selected server", async () => {
    vi.stubEnv("MCP_TEST_COMMAND", "/usr/bin/test-mcp");
    vi.stubEnv("MCP_TEST_TOKEN", "secret-token");
    vi.stubEnv("MCP_TEST_BASE_URL", "https://api.example.com");
    vi.stubEnv("MCP_TEST_CLIENT_ID", "oauth-client");
    vi.stubEnv("MCP_TEST_CLIENT_SECRET", "oauth-secret");
    vi.stubEnv("MCP_TEST_CACHE", undefined);
    await t.writeConfig({
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
          oauth: {
            authServerMetadataUrl: `${envVarRef("MCP_TEST_BASE_URL")}/metadata`,
            clientId: envVarRef("MCP_TEST_CLIENT_ID"),
            clientSecret: envVarRef("MCP_TEST_CLIENT_SECRET"),
            clientName: `Pi ${envVarRef("MCP_TEST_CLIENT_ID")}`,
            callbackPort: 33418,
            scopes: `tools:${envVarRef("MCP_TEST_CLIENT_ID")}`,
          },
          type: "http",
          url: `${envVarRef("MCP_TEST_BASE_URL")}/mcp`,
        },
      },
    });

    const config = await loadMcpConfig();

    expect({
      mcpServers: {
        local: resolveMcpServer(config, "local"),
        remote: resolveMcpServer(config, "remote"),
      },
    }).toStrictEqual({
      mcpServers: {
        local: {
          args: ["--cache", "/tmp/cache"],
          command: "/usr/bin/test-mcp",
          env: { API_TOKEN: "secret-token" },
          type: "stdio",
        },
        remote: {
          headers: { Authorization: "Bearer secret-token" },
          oauth: {
            authServerMetadataUrl: "https://api.example.com/metadata",
            clientId: "oauth-client",
            clientSecret: "oauth-secret",
            clientName: "Pi oauth-client",
            callbackPort: 33418,
            scopes: "tools:oauth-client",
          },
          type: "http",
          url: "https://api.example.com/mcp",
        },
      },
    });
  });

  it("reports missing environment variables", async () => {
    vi.stubEnv("MCP_TEST_MISSING_TOKEN", undefined);
    await t.writeConfig({
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

    await expect(listMcpServers({})).resolves.toStrictEqual([{ name: "remote", scope: "global" }]);
    const config = await loadMcpConfig();
    expect(() => resolveMcpServer(config, "remote")).toThrow(
      "missing environment variable in MCP config: MCP_TEST_MISSING_TOKEN",
    );
  });
});
