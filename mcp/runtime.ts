import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import {
  auth,
  UnauthorizedError,
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  OAuthClientProvider,
  Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Type } from "typebox";
import type { TSchema } from "typebox";

import type { HttpServerConfig, McpConfig } from "./config.js";
import {
  PersistentMcpOAuthProvider,
  startOAuthCallbackServer,
} from "./oauth.js";
import type { OAuthCallbackServer } from "./oauth.js";

const TOOL_NAME_PREFIX = "mcp_";
const OPEN_OBJECT_SCHEMA = Type.Object({}, { additionalProperties: true });

interface ConnectedServer {
  client: Client;
  serverConfig: McpConfig["mcpServers"][string];
  toolNames: string[];
  transport: Transport;
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
}

interface McpLoadResult {
  serverName: string;
  toolCount: number;
  toolNames: string[];
}

interface LoadServerOptions {
  pi: ExtensionAPI;
  serverName: string;
  serverConfig: McpConfig["mcpServers"][string];
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
  interactive: boolean;
  signal?: AbortSignal;
}

type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error) || !error.message) {
    return String(error);
  }
  if (
    error.message.includes(
      "Incompatible auth server: does not support dynamic client registration"
    )
  ) {
    return `${error.message}. Configure oauth.clientId for this MCP server.`;
  }
  return error.message;
};

const activateTools = (
  pi: ExtensionAPI,
  toolNames: readonly string[]
): void => {
  const active = pi.getActiveTools();
  const activeSet = new Set(active);
  const toAdd = toolNames.filter((name) => !activeSet.has(name));
  if (toAdd.length > 0) {
    pi.setActiveTools([...active, ...toAdd]);
  }
};

const authorizeHttpProvider = async (
  serverName: string,
  serverUrl: URL,
  authProvider: OAuthClientProvider,
  callbackServer: OAuthCallbackServer | undefined,
  interactive: boolean,
  signal?: AbortSignal
): Promise<void> => {
  const result = await auth(authProvider, { serverUrl });
  if (result === "AUTHORIZED") {
    return;
  }
  if (!interactive || !callbackServer) {
    throw new UnauthorizedError(
      `MCP server ${serverName} requires interactive OAuth authorization`
    );
  }

  const code = await callbackServer.waitForCode(signal);
  const finishResult = await auth(authProvider, {
    authorizationCode: code,
    serverUrl,
  });
  if (finishResult !== "AUTHORIZED") {
    throw new UnauthorizedError("Failed to authorize MCP server");
  }
};

const sanitizeNameComponent = (value: string): string => {
  let normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, "_")
    .replaceAll(/_+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  if (!normalized) {
    normalized = "unnamed";
  }
  return /^[0-9]/u.test(normalized) ? `_${normalized}` : normalized;
};

const toGeneratedToolName = (serverName: string, toolName: string): string =>
  `${TOOL_NAME_PREFIX}${sanitizeNameComponent(serverName)}__${sanitizeNameComponent(toolName)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
};

const toToolParametersSchema = (inputSchema: unknown): TSchema =>
  isRecord(inputSchema) && inputSchema.type === "object"
    ? inputSchema
    : OPEN_OBJECT_SCHEMA;

const normalizeToolArguments = (args: unknown): Record<string, unknown> =>
  isRecord(args) ? args : {};

const mcpResultIsError = (result: unknown): boolean =>
  isRecord(result) && result.isError === true;

const mcpResultToPiContent = (
  result: unknown
): { content: PiToolContent[]; truncated: boolean } => {
  const items =
    isRecord(result) && Array.isArray(result.content)
      ? result.content
      : [result];
  const text: string[] = [];
  const images: PiToolContent[] = [];

  for (const item of items) {
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      text.push(item.text);
    } else if (
      isRecord(item) &&
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      images.push({ data: item.data, mimeType: item.mimeType, type: "image" });
    } else {
      text.push(safeJson(item));
    }
  }

  const truncated = truncateHead(text.join("\n"));
  const notice = truncated.truncated
    ? `\n\n[MCP output truncated: kept ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}]`
    : "";
  const content: PiToolContent[] = [
    { text: `${truncated.content}${notice}`, type: "text" },
    ...images,
  ];
  return { content, truncated: truncated.truncated };
};

const contentToText = (result: unknown): string =>
  mcpResultToPiContent(result)
    .content.map((item) =>
      item.type === "text" ? item.text : `[image:${item.mimeType}]`
    )
    .join("\n");

const createHttpAuthProvider = (
  serverName: string,
  serverConfig: HttpServerConfig,
  ui: Pick<ExtensionCommandContext["ui"], "notify">,
  interactive: boolean
): PersistentMcpOAuthProvider | undefined => {
  if (!serverConfig.oauth) {
    return undefined;
  }
  return new PersistentMcpOAuthProvider(
    serverName,
    serverConfig.oauth,
    (url) => {
      if (!interactive) {
        throw new UnauthorizedError(
          `MCP server ${serverName} requires interactive OAuth authorization`
        );
      }
      ui.notify(
        `Authorize MCP server ${serverName}:\n${url.toString()}\nWaiting for OAuth authorization...`,
        "info"
      );
    }
  );
};

const connectToServer = async (
  serverName: string,
  serverConfig: McpConfig["mcpServers"][string],
  ui: Pick<ExtensionCommandContext["ui"], "notify">,
  interactive: boolean,
  signal?: AbortSignal
): Promise<Pick<ConnectedServer, "client" | "transport">> => {
  const client = new Client({ name: "pi-mcp", version: "0.1.0" });

  if (serverConfig.type === "stdio") {
    const transport = new StdioClientTransport({
      args: serverConfig.args,
      command: serverConfig.command,
      env: serverConfig.env,
      stderr: "ignore",
    });
    await client.connect(transport);
    return { client, transport };
  }

  const serverUrl = new URL(serverConfig.url);
  const authProvider = createHttpAuthProvider(
    serverName,
    serverConfig,
    ui,
    interactive
  );
  let callbackServer: OAuthCallbackServer | undefined;
  try {
    if (authProvider) {
      if (interactive) {
        callbackServer = await startOAuthCallbackServer(
          authProvider.redirectUrl,
          authProvider.expectedState
        );
      }
      await authorizeHttpProvider(
        serverName,
        serverUrl,
        authProvider,
        callbackServer,
        interactive,
        signal
      );
    }

    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider,
      requestInit: { headers: serverConfig.headers ?? {} },
    });
    await client.connect(transport);
    return { client, transport };
  } finally {
    await callbackServer?.close().catch(() => {
      // Best-effort cleanup after the authorization attempt.
    });
  }
};

export class McpRuntime {
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

    const connection = await connectToServer(
      options.serverName,
      options.serverConfig,
      options.ui,
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
        serverConfig: options.serverConfig,
        toolNames: result.toolNames,
        ui: options.ui,
      });
      return result;
    } catch (error) {
      await connection.transport.close().catch(() => {
        // Preserve the registration error that triggered cleanup.
      });
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    const transports = [...this.servers.values()].map(
      ({ transport }) => transport
    );
    this.servers.clear();
    await Promise.allSettled(transports.map((transport) => transport.close()));
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
      const connection = await connectToServer(
        serverName,
        stale.serverConfig,
        stale.ui,
        false
      );
      const replacement = { ...stale, ...connection };
      this.servers.set(serverName, replacement);
      await stale.transport.close().catch(() => {
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

export { errorMessage };
