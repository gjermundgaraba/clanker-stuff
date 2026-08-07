import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  auth,
  UnauthorizedError,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  OAuthClientProvider,
  Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { HttpServerConfig, McpConfig } from "./config.js";
import {
  PersistentMcpOAuthProvider,
  startOAuthCallbackServer,
} from "./oauth.js";
import type { OAuthCallbackServer } from "./oauth.js";

export interface McpClientConnection {
  client: Client;
  close: () => Promise<void>;
  transport: Transport;
}

export type McpConnectionFactory = (
  interactive: boolean,
  signal?: AbortSignal
) => Promise<McpClientConnection>;

export const errorMessage = (error: unknown): string => {
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

export const connectToServer = async (
  serverName: string,
  serverConfig: McpConfig["mcpServers"][string],
  ui: Pick<ExtensionCommandContext["ui"], "notify">,
  interactive: boolean,
  signal?: AbortSignal
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
    return { client, close: () => client.close(), transport };
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
    await client.connect(transport, signal ? { signal } : undefined);
    return { client, close: () => client.close(), transport };
  } finally {
    await callbackServer?.close().catch(() => {
      // Best-effort cleanup after the authorization attempt.
    });
  }
};
