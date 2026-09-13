import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SamplingUsage } from "./sampling.js";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SdkHttpError } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import type { TUnsafe } from "typebox";

import { activateTools, mcpResultToPiContent, toGeneratedToolName } from "./bridge.js";
import type { McpClientConnection, McpConnectionFactory } from "./connection.js";
import { isAuthorizationError } from "./oauth.js";
import { createOutputStore } from "./results.js";

type ToolArguments = NonNullable<
  Parameters<McpClientConnection["client"]["callTool"]>[0]["arguments"]
>;

export type McpToolRegistry = Pick<
  ExtensionAPI,
  "getActiveTools" | "getAllTools" | "registerTool" | "setActiveTools"
>;
export interface McpToolDetails {
  outputPath?: string;
  serverName: string;
  toolName: string;
  truncated: boolean;
}
interface ServerRecord {
  connection?: McpClientConnection;
  toolNames: string[];
  registeredNames: Set<string>;
}
interface LoadServerOptions {
  connectionFactory: McpConnectionFactory;
  serverName: string;
  interactive: boolean;
  reconnect?: boolean;
  signal?: AbortSignal;
}

export class McpServerPool {
  private readonly loads = new Map<string, Promise<number>>();
  private readonly servers = new Map<string, ServerRecord>();
  private readonly shutdown = new AbortController();
  private calls = new AbortController();
  private readonly accounting = new Map<string, SamplingUsage[]>();
  private readonly persistOutput = createOutputStore();

  private readonly pi: McpToolRegistry;

  constructor(pi: McpToolRegistry) {
    this.pi = pi;
  }

  hasServer(name: string): boolean {
    return this.servers.get(name)?.connection !== undefined;
  }

  async loadServer(options: LoadServerOptions): Promise<number> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const pending = this.loads.get(options.serverName);
    const load = (async () => {
      // Failure belongs to the preceding caller, not to this requested operation.
      if (pending) await pending.catch(() => {});
      signal.throwIfAborted();
      return await this.load(options, signal);
    })();
    this.loads.set(options.serverName, load);
    const settled = () => {
      if (this.loads.get(options.serverName) === load) this.loads.delete(options.serverName);
    };
    void load.then(settled, settled);
    return await raceWithAbortSignal(load, signal);
  }

  reconcileActiveServers(names: readonly string[]): void {
    const desired = new Set(names);
    const managed = new Set(
      [...this.servers.values()].flatMap((server) => [...server.registeredNames]),
    );
    const active = this.pi.getActiveTools().filter((name) => !managed.has(name));
    for (const [name, server] of this.servers) {
      if (desired.has(name) && server.connection) active.push(...server.toolNames);
    }
    this.pi.setActiveTools([...new Set(active)]);
  }

  private disconnect(server: ServerRecord, connection: McpClientConnection): void {
    if (server.connection !== connection) return;
    delete server.connection;
    this.pi.setActiveTools(
      this.pi.getActiveTools().filter((name) => !server.registeredNames.has(name)),
    );
  }

  private async load(options: LoadServerOptions, signal: AbortSignal): Promise<number> {
    const { serverName } = options;
    let server = this.servers.get(serverName);
    if (server?.connection && !options.reconnect) {
      activateTools(this.pi, server.toolNames);
      return server.toolNames.length;
    }
    if (!server) {
      server = {
        toolNames: [],
        registeredNames: new Set(),
      };
      this.servers.set(serverName, server);
    }
    if (server.connection) {
      const old = server.connection;
      this.disconnect(server, old);
      await old.close();
    }
    signal.throwIfAborted();
    const connection = await options.connectionFactory(options.interactive, signal);
    try {
      const { tools } = await connection.client.listTools(undefined, { signal });
      signal.throwIfAborted();
      connection.closed?.throwIfAborted();
      const occupied = new Set(
        this.pi
          .getAllTools()
          .map((tool) => tool.name)
          .filter((name) => !server.registeredNames.has(name)),
      );
      const definitions: ToolDefinition<TUnsafe<ToolArguments>, McpToolDetails>[] = tools.map(
        (tool) => {
          const name = toGeneratedToolName(serverName, tool.name);
          if (occupied.has(name)) throw new Error(`MCP tool name collision: ${name}`);
          occupied.add(name);
          return {
            name,
            label: `${serverName}: ${tool.name}`,
            description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
            parameters: Type.Unsafe<ToolArguments>(tool.inputSchema),
            execute: async (id, args, executeSignal, _update, ctx) => {
              const sampling: SamplingUsage[] = [];
              this.accounting.set(id, sampling);
              const result = await this.callTool(
                serverName,
                tool.name,
                args,
                executeSignal,
                ctx,
                (usage) => sampling.push(usage),
              );
              const converted = mcpResultToPiContent(result);
              const details: McpToolDetails = {
                serverName,
                toolName: tool.name,
                truncated: converted.truncated,
              };
              if (converted.truncated) {
                try {
                  details.outputPath = await this.persistOutput(converted.fullText);
                  converted.content.push({
                    type: "text",
                    text: `[Persisted output: ${details.outputPath}; temporary, may be partial]`,
                  });
                } catch {
                  converted.content.push({
                    type: "text",
                    text: "[Could not persist overflow. The remote operation has already completed; do not retry solely for this warning.]",
                  });
                }
              }
              if (result.isError) {
                throw new Error(
                  `MCP tool ${tool.name} from ${serverName} returned an error: ${converted.content.map((item) => (item.type === "text" ? item.text : `[image:${item.mimeType}]`)).join("\n")}`,
                );
              }
              return { content: converted.content, details };
            },
          };
        },
      );
      for (const definition of definitions) {
        this.pi.registerTool(definition);
        server.registeredNames.add(definition.name);
      }
      server.toolNames = definitions.map((tool) => tool.name);
      server.connection = connection;
      const record = server;
      connection.closed?.addEventListener("abort", () => this.disconnect(record, connection), {
        once: true,
      });
      activateTools(this.pi, server.toolNames);
      return tools.length;
    } catch (error) {
      await connection.close().catch(() => {
        /* Preserve the loading error. */
      });
      throw error;
    }
  }

  cancelCalls(): void {
    this.calls.abort();
    this.calls = new AbortController();
  }

  takeUsage(id: string): SamplingUsage[] | undefined {
    const usage = this.accounting.get(id);
    this.accounting.delete(id);
    return usage?.length ? usage : undefined;
  }

  async closeAll(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    this.cancelCalls();
    const connections = [...this.servers.values()].flatMap((server) =>
      server.connection ? [server.connection] : [],
    );
    await Promise.allSettled([
      ...connections.map((connection) => connection.close()),
      ...this.loads.values(),
    ]);
    this.servers.clear();
  }

  private async callTool(
    serverName: string,
    toolName: string,
    args: Parameters<McpClientConnection["client"]["callTool"]>[0]["arguments"],
    signal?: AbortSignal,
    ctx?: ExtensionContext,
    reportUsage: (usage: SamplingUsage) => void = () => {},
  ): Promise<CallToolResult> {
    const server = this.servers.get(serverName);
    const connection = server?.connection;
    if (!server || !connection)
      throw new Error(
        `MCP server ${serverName} is disconnected. Reconnect with /mcp or mcp_connect.`,
      );
    signal = AbortSignal.any([
      this.shutdown.signal,
      this.calls.signal,
      ...(signal ? [signal] : []),
      ...(connection.closed ? [connection.closed] : []),
    ]);
    const call = () => connection.client.callTool({ name: toolName, arguments: args }, { signal });
    try {
      return await (ctx && connection.withContext
        ? connection.withContext({ ctx, model: ctx.model, signal, reportUsage }, call)
        : call());
    } catch (error) {
      signal?.throwIfAborted();
      const authorization = isAuthorizationError(error);
      const expired =
        connection.transport.sessionId !== undefined &&
        SdkHttpError.isInstance(error) &&
        error.status === 404;
      if (!authorization && !expired) throw error;
      this.disconnect(server, connection);
      await connection.close().catch(() => {
        /* Preserve the request failure. */
      });
      throw new Error(
        `MCP server ${serverName} ${authorization ? "requires authorization" : "session expired"}. Reconnect with /mcp or mcp_connect.`,
        { cause: error },
      );
    }
  }
}
