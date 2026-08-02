import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

import { ServerConfigSchema } from "./config.js";
import type {
  ListedMcpServer,
  McpConfigScope,
  McpServerConfig,
} from "./config.js";
import type { McpClientConnection } from "./connection.js";

export const MCP_MANAGER_SERVER_NAME = "mcp-manager";

const ScopeSchema = z.enum(["global", "project"]);

export interface McpManagerListResult {
  error?: string;
  servers: (ListedMcpServer | { name: string; scope: "built-in" })[];
}

export interface McpManagerBackend {
  add: (
    name: string,
    serverConfig: McpServerConfig,
    scope: McpConfigScope,
    signal: AbortSignal
  ) => Promise<void>;
  connect: (name: string, signal: AbortSignal) => Promise<number>;
  list: (signal: AbortSignal) => Promise<McpManagerListResult>;
  remove: (
    name: string,
    scope: McpConfigScope,
    signal: AbortSignal
  ) => Promise<void>;
}

const textResult = (text: string) => ({
  content: [{ text, type: "text" as const }],
});

const createManagerServer = (backend: McpManagerBackend): McpServer => {
  const server = new McpServer({
    name: "pi-mcp-manager",
    version: "0.1.0",
  });

  server.registerTool(
    "add_mcp",
    {
      description:
        "Add an MCP server to the global or trusted project-local configuration",
      inputSchema: z
        .object({
          config: ServerConfigSchema,
          name: z.string().min(1),
          scope: ScopeSchema,
        })
        .strict(),
    },
    async ({ config, name, scope }, ctx) => {
      await backend.add(name, config, scope, ctx.mcpReq.signal);
      return textResult(`Added MCP server ${name} to the ${scope} config`);
    }
  );

  server.registerTool(
    "remove_mcp",
    {
      description:
        "Remove an MCP server from the global or trusted project-local configuration",
      inputSchema: z
        .object({
          name: z.string().min(1),
          scope: ScopeSchema,
        })
        .strict(),
    },
    async ({ name, scope }, ctx) => {
      await backend.remove(name, scope, ctx.mcpReq.signal);
      return textResult(`Removed MCP server ${name} from the ${scope} config`);
    }
  );

  server.registerTool(
    "list_mcps",
    {
      description:
        "List accessible MCP servers without exposing their configuration",
      inputSchema: z.object({}).strict(),
    },
    async (_args, ctx) => {
      const result = await backend.list(ctx.mcpReq.signal);
      const lines = result.servers.map(
        ({ name, scope }) => `${name} (${scope})`
      );
      if (result.error) {
        lines.push("", `Warning: ${result.error}`);
      }
      return textResult(lines.join("\n"));
    }
  );

  server.registerTool(
    "connect",
    {
      description:
        "Connect an accessible MCP server and activate its tools in the current pi session",
      inputSchema: z.object({ name: z.string().min(1) }).strict(),
    },
    async ({ name }, ctx) => {
      const toolCount = await backend.connect(name, ctx.mcpReq.signal);
      return textResult(
        `MCP server ${name} was loaded with ${toolCount} tools`
      );
    }
  );

  return server;
};

export const createMcpManagerConnection = async (
  backend: McpManagerBackend,
  signal?: AbortSignal
): Promise<McpClientConnection> => {
  signal?.throwIfAborted();
  // ponytail: process-local transport; use a process transport if isolation is needed.
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serverHandle = serveStdio(() => createManagerServer(backend), {
    legacy: "reject",
    transport: serverTransport,
  });
  const client = new Client(
    { name: "pi-mcp", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );

  try {
    await client.connect(
      clientTransport,
      signal === undefined ? undefined : { signal }
    );
  } catch (error) {
    await serverHandle.close().catch(() => {
      // Preserve the connection error.
    });
    throw error;
  }

  return {
    client,
    close: async () => {
      const results = await Promise.allSettled([
        client.close(),
        serverHandle.close(),
      ]);
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (failed) {
        throw failed.reason;
      }
    },
    transport: clientTransport,
  };
};
