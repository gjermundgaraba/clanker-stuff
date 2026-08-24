import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { listMcpServers, loadMcpConfig, McpConfigSchema } from "../config.js";
import { envVarRef, setupMcpTest } from "./helpers.js";

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
    expect(McpConfigSchema.safeParse(config).success).toBeTruthy();
  });

  it("accepts OAuth http server config", () => {
    expect(
      McpConfigSchema.safeParse({
        mcpServers: {
          interactive: {
            oauth: {
              authServerMetadataUrl: "https://auth.example.com/.well-known/openid-configuration",
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
      }).success,
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
    expect(McpConfigSchema.safeParse(config).success).toBeTruthy();
  });

  it("rejects unknown server config fields", () => {
    expect(
      McpConfigSchema.safeParse({
        mcpServers: {
          api: {
            extra: true,
            type: "http",
            url: "https://mcp.example.com",
          },
        },
      }).success,
    ).toBeFalsy();
    expect(
      McpConfigSchema.safeParse({
        mcpServers: {
          local: {
            command: "/usr/bin/mcp-local",
            extra: true,
            type: "stdio",
          },
        },
      }).success,
    ).toBeFalsy();
  });
});

describe(loadMcpConfig, () => {
  const t = setupMcpTest();

  it("loads project-local .pi/mcp.json when global config is missing", async () => {
    await t.writeLocalConfig({
      mcpServers: {
        project: {
          oauth: {},
          type: "streamable-http",
          url: "https://project.example.com/mcp",
        },
      },
    });

    await expect(loadMcpConfig({ cwd: t.projectDir, projectTrusted: true })).resolves.toStrictEqual(
      {
        mcpServers: {
          project: {
            oauth: {},
            type: "streamable-http",
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

  it("rejects invalid project-local config", async () => {
    await mkdir(path.dirname(t.localConfigPath), { recursive: true });
    await writeFile(
      t.localConfigPath,
      JSON.stringify({ mcpServers: { bad: { type: "stdio" } } }),
      "utf-8",
    );

    await expect(loadMcpConfig({ cwd: t.projectDir, projectTrusted: true })).rejects.toThrow(
      /invalid config .*mcp\.json/u,
    );
  });

  it("expands Claude-style environment variables", async () => {
    process.env.MCP_TEST_COMMAND = "/usr/bin/test-mcp";
    process.env.MCP_TEST_TOKEN = "secret-token";
    process.env.MCP_TEST_BASE_URL = "https://api.example.com";
    process.env.MCP_TEST_CLIENT_ID = "oauth-client";
    process.env.MCP_TEST_CLIENT_SECRET = "oauth-secret";
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
            scopes: `tools:${envVarRef("MCP_TEST_CLIENT_ID")}`,
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
          oauth: {
            authServerMetadataUrl: "https://api.example.com/metadata",
            clientId: "oauth-client",
            clientSecret: "oauth-secret",
            scopes: "tools:oauth-client",
          },
          type: "http",
          url: "https://api.example.com/mcp",
        },
      },
    });

    Reflect.deleteProperty(process.env, "MCP_TEST_COMMAND");
    Reflect.deleteProperty(process.env, "MCP_TEST_TOKEN");
    Reflect.deleteProperty(process.env, "MCP_TEST_BASE_URL");
    Reflect.deleteProperty(process.env, "MCP_TEST_CLIENT_ID");
    Reflect.deleteProperty(process.env, "MCP_TEST_CLIENT_SECRET");
  });

  it("reports missing environment variables", async () => {
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
    await expect(loadMcpConfig()).rejects.toThrow(
      "missing environment variable in MCP config: MCP_TEST_MISSING_TOKEN",
    );
  });
});
