import {
  InsufficientScopeError,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "./config.js";
import { createHttpAuth, isAuthorizationError } from "./oauth.js";

export type McpClient = Pick<Client, "callTool" | "listTools">;
export interface McpClientConnection {
  client: McpClient;
  close: () => Promise<void>;
  transport: Pick<Transport, "sessionId">;
  closed?: AbortSignal;
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

const connectTransport = async (
  client: Client,
  transport: Transport,
  signal: AbortSignal,
): Promise<void> => {
  signal.throwIfAborted();
  // The SDK's discovery probe ignores connect()'s signal until negotiation finishes.
  const onAbort = () => {
    void transport.close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect(transport, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

interface ConnectOptions {
  serverConfig: McpServerConfig;
  onAuthorizationUrl?: (url: URL) => void;
  signal?: AbortSignal;
  cwd?: string;
}

export const connectToServer = async ({
  serverConfig,
  onAuthorizationUrl,
  signal,
  cwd,
}: ConnectOptions): Promise<McpClientConnection> => {
  const httpAuth =
    serverConfig.type === "http" && serverConfig.oauth ? createHttpAuth(serverConfig) : undefined;
  const lifetime = new AbortController();
  const attempt = async (): Promise<McpClientConnection> => {
    const connectSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    connectSignal.throwIfAborted();
    httpAuth?.setSignal(connectSignal);
    const client = new Client(
      { name: "pi-mcp", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport: Transport =
      serverConfig.type === "stdio"
        ? new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
            cwd,
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(serverConfig.url), {
            authProvider: httpAuth?.authProvider,
            requestInit: { headers: serverConfig.headers ?? {} },
          });
    try {
      await connectTransport(client, transport, connectSignal);
      connectSignal.throwIfAborted();
      httpAuth?.setSignal(lifetime.signal);
      client.onclose = () => lifetime.abort();
      return {
        client,
        transport,
        closed: lifetime.signal,
        close: async () => {
          lifetime.abort();
          await client.close();
        },
      };
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  };
  try {
    return await attempt();
  } catch (error) {
    const scopeError = error instanceof InsufficientScopeError ? error : undefined;
    if (!httpAuth || !onAuthorizationUrl || !isAuthorizationError(error)) throw error;
    await httpAuth.authorize(onAuthorizationUrl, signal, scopeError);
    return await attempt();
  }
};
