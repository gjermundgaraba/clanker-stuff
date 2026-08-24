import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  auth,
  UnauthorizedError,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { HttpServerConfig, McpConfig } from "./config.js";
import { PersistentMcpOAuthProvider, startOAuthCallbackServer } from "./oauth.js";

export type McpClient = Pick<Client, "callTool" | "listTools">;

export interface McpTransport {
  readonly sessionId?: string;
}

export interface McpClientConnection {
  client: McpClient;
  close: () => Promise<void>;
  transport: McpTransport;
}

export type McpConnectionFactory = (
  interactive: boolean,
  signal?: AbortSignal,
) => Promise<McpClientConnection>;

export const errorMessage = (cause: unknown): string => {
  if (!(cause instanceof Error) || !cause.message) {
    return String(cause);
  }
  if (
    cause.message.includes("Incompatible auth server: does not support dynamic client registration")
  ) {
    return `${cause.message}. Configure oauth.clientId for this MCP server.`;
  }
  return cause.message;
};

const authorizeHttpProvider = async (
  serverName: string,
  serverUrl: URL,
  authProvider: {
    notifyAuthorizationUrl: () => void;
    provider: PersistentMcpOAuthProvider;
  },
  interactive: boolean,
  signal?: AbortSignal,
): Promise<void> => {
  const result = await auth(authProvider.provider, { serverUrl });
  if (result === "AUTHORIZED") {
    return;
  }
  if (!interactive) {
    throw new UnauthorizedError(
      `MCP server ${serverName} requires interactive OAuth authorization`,
    );
  }

  const callbackServer = await startOAuthCallbackServer(
    authProvider.provider.redirectUrl,
    authProvider.provider.expectedState,
  );
  try {
    authProvider.notifyAuthorizationUrl();
    const { code, iss } = await callbackServer.waitForCode(signal);
    const finishResult = await auth(authProvider.provider, {
      authorizationCode: code,
      iss,
      serverUrl,
    });
    if (finishResult !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize MCP server");
    }
  } finally {
    await callbackServer.close().catch(() => {
      // Best-effort cleanup after the authorization attempt.
    });
  }
};

const createHttpAuthProvider = (
  serverName: string,
  serverConfig: HttpServerConfig,
  ui: Pick<ExtensionCommandContext["ui"], "notify">,
  interactive: boolean,
):
  | {
      notifyAuthorizationUrl: () => void;
      provider: PersistentMcpOAuthProvider;
    }
  | undefined => {
  if (!serverConfig.oauth) {
    return undefined;
  }
  let authorizationUrl: URL | undefined;
  const provider = new PersistentMcpOAuthProvider(serverName, serverConfig.oauth, (url) => {
    if (!interactive) {
      throw new UnauthorizedError(
        `MCP server ${serverName} requires interactive OAuth authorization`,
      );
    }
    authorizationUrl = url;
  });
  return {
    notifyAuthorizationUrl: () => {
      if (!authorizationUrl) {
        throw new UnauthorizedError(
          `MCP server ${serverName} did not provide an OAuth authorization URL`,
        );
      }
      ui.notify(
        `Authorize MCP server ${serverName}:\n${authorizationUrl.toString()}\nWaiting for OAuth authorization...`,
        "info",
      );
    },
    provider,
  };
};

export const connectToServer = async (
  serverName: string,
  serverConfig: McpConfig["mcpServers"][string],
  ui: Pick<ExtensionCommandContext["ui"], "notify">,
  interactive: boolean,
  signal?: AbortSignal,
): Promise<McpClientConnection> => {
  const client = new Client({ name: "pi-mcp", version: "0.1.0" });

  if (serverConfig.type === "stdio") {
    const transport = new StdioClientTransport({
      args: serverConfig.args,
      command: serverConfig.command,
      env: serverConfig.env,
      stderr: "ignore",
    });
    await client.connect(transport, signal ? { signal } : undefined);
    return { client, close: () => client.close(), transport: {} };
  }

  const serverUrl = new URL(serverConfig.url);
  const authProvider = createHttpAuthProvider(serverName, serverConfig, ui, interactive);
  if (authProvider) {
    await authorizeHttpProvider(serverName, serverUrl, authProvider, interactive, signal);
  }

  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: authProvider?.provider,
    requestInit: { headers: serverConfig.headers ?? {} },
  });
  await client.connect(transport, signal ? { signal } : undefined);
  return { client, close: () => client.close(), transport };
};
