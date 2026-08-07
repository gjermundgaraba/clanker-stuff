import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Client, Transport } from "@modelcontextprotocol/client";

import {
  activateTools,
  contentToText,
  mcpResultIsError,
  mcpResultToPiContent,
  normalizeToolArguments,
  toGeneratedToolName,
  toToolParametersSchema,
} from "./bridge.js";
import type { McpConfig } from "./config.js";
import { connectToServer } from "./connection.js";
import type { McpConnectionFactory } from "./connection.js";

interface ConnectedServer {
  client: Client;
  close: () => Promise<void>;
  connectionFactory: McpConnectionFactory;
  toolNames: string[];
  transport: Transport;
}

interface McpLoadResult {
  serverName: string;
  toolCount: number;
  toolNames: string[];
}

interface LoadServerOptions {
  connectionFactory?: McpConnectionFactory;
  pi: ExtensionAPI;
  serverName: string;
  serverConfig?: McpConfig["mcpServers"][string];
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
  interactive: boolean;
  signal?: AbortSignal;
}

export class McpServerPool {
  private readonly reconnects = new Map<string, Promise<ConnectedServer>>();
  private readonly servers = new Map<string, ConnectedServer>();

  async loadServer(options: LoadServerOptions): Promise<McpLoadResult> {
    const existing = this.servers.get(options.serverName);
    if (existing) {
      activateTools(options.pi, existing.toolNames);
      return {
        serverName: options.serverName,
        toolCount: existing.toolNames.length,
        toolNames: existing.toolNames,
      };
    }

    const { connectionFactory: providedConnectionFactory, serverConfig } =
      options;
    const connectionFactory =
      providedConnectionFactory ??
      (serverConfig === undefined
        ? undefined
        : (interactive: boolean, signal?: AbortSignal) =>
            connectToServer(
              options.serverName,
              serverConfig,
              options.ui,
              interactive,
              signal
            ));
    if (!connectionFactory) {
      throw new Error(`MCP server ${options.serverName} has no connection`);
    }

    const connection = await connectionFactory(
      options.interactive,
      options.signal
    );
    try {
      const result = await this.registerMcpTools(
        options.pi,
        options.serverName,
        connection.client,
        options.signal
      );
      this.servers.set(options.serverName, {
        ...connection,
        connectionFactory,
        toolNames: result.toolNames,
      });
      return result;
    } catch (error) {
      await connection.close().catch(() => {
        // Preserve the registration error that triggered cleanup.
      });
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    const closeConnections = [...this.servers.values()].map(
      ({ close }) => close
    );
    this.servers.clear();
    await Promise.allSettled(closeConnections.map((close) => close()));
  }

  private async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`MCP server ${serverName} is not connected`);
    }

    const request = {
      arguments: normalizeToolArguments(args),
      name: toolName,
    };
    const options = signal ? { signal } : undefined;
    const sessionId =
      connection.transport instanceof StreamableHTTPClientTransport
        ? connection.transport.sessionId
        : undefined;

    try {
      return await connection.client.callTool(request, options);
    } catch (error) {
      if (
        sessionId === undefined ||
        !SdkHttpError.isInstance(error) ||
        error.status !== 404
      ) {
        throw error;
      }
    }

    const reconnected = await this.reconnectServer(serverName, connection);
    return await reconnected.client.callTool(request, options);
  }

  private async reconnectServer(
    serverName: string,
    stale: ConnectedServer
  ): Promise<ConnectedServer> {
    const current = this.servers.get(serverName);
    if (!current) {
      throw new Error(`MCP server ${serverName} is not connected`);
    }
    if (current !== stale) {
      return current;
    }

    const pending = this.reconnects.get(serverName);
    if (pending) {
      return await pending;
    }

    const reconnect = (async () => {
      const connection = await stale.connectionFactory(false);
      const replacement = { ...stale, ...connection };
      this.servers.set(serverName, replacement);
      await stale.close().catch(() => {
        // The replacement connection is already active.
      });
      return replacement;
    })();
    this.reconnects.set(serverName, reconnect);
    try {
      return await reconnect;
    } finally {
      this.reconnects.delete(serverName);
    }
  }

  private async registerMcpTools(
    pi: ExtensionAPI,
    serverName: string,
    client: Client,
    signal?: AbortSignal
  ): Promise<McpLoadResult> {
    const { tools } = await client.listTools(
      undefined,
      signal ? { signal } : undefined
    );
    const occupiedNames = new Set(pi.getAllTools().map(({ name }) => name));
    const generatedNames = new Set<string>();
    const callTool = this.callTool.bind(this);

    const generatedTools: ToolDefinition[] = tools.map((tool) => {
      const generatedToolName = toGeneratedToolName(serverName, tool.name);
      if (
        occupiedNames.has(generatedToolName) ||
        generatedNames.has(generatedToolName)
      ) {
        throw new Error(
          `MCP tool name collision for ${serverName}/${tool.name}: ${generatedToolName}`
        );
      }
      generatedNames.add(generatedToolName);

      return {
        description:
          tool.description ?? `MCP tool ${tool.name} from server ${serverName}`,
        async execute(_toolCallId, params, executeSignal) {
          const result = await callTool(
            serverName,
            tool.name,
            params,
            executeSignal
          );
          if (mcpResultIsError(result)) {
            throw new Error(
              `MCP tool ${tool.name} from server ${serverName} returned an error: ${contentToText(result)}`
            );
          }
          const converted = mcpResultToPiContent(result);
          return {
            content: converted.content,
            details: {
              serverName,
              toolName: tool.name,
              truncated: converted.truncated,
            },
          };
        },
        label: `${serverName}: ${tool.name}`,
        name: generatedToolName,
        parameters: toToolParametersSchema(tool.inputSchema),
      };
    });

    for (const tool of generatedTools) {
      pi.registerTool(tool);
    }
    const toolNames = generatedTools.map(({ name }) => name);
    activateTools(pi, toolNames);
    return { serverName, toolCount: tools.length, toolNames };
  }
}
