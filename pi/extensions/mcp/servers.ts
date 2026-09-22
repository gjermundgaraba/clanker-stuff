import { mcpRenderers } from "./renderers.js";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";
import type { SamplingUsage } from "./sampling.js";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import type { TUnsafe } from "typebox";

import { activateTools, mcpResultToPiContent, toGeneratedToolName } from "./bridge.js";
import type { McpClientConnection, McpConnectionFactory } from "./connection.js";
import { errorMessage } from "./connection.js";
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
  overflowNoticeIndex?: number;
  outputPath?: string;
  serverName: string;
  toolName: string;
  truncated: boolean;
}

interface ServerRecord {
  connection?: McpClientConnection;
  toolNames: string[];
  registeredNames: Set<string>;
  desired: boolean;
  maintenance: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  recovery?: Promise<void>;
  settings?: Pick<
    LoadServerOptions,
    "serverName" | "connectionFactory" | "heartbeatIntervalMs" | "heartbeatTimeoutMs"
  >;
  activeCalls: number;
  pingSupported: boolean;
  connectedAt?: number;
  retryDelayMs: number;
  recoveryWarned: boolean;
}

interface LoadServerOptions {
  connectionFactory: McpConnectionFactory;
  serverName: string;
  interactive: boolean;
  reconnect?: boolean;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

const sessionExpired = (connection: McpClientConnection, cause: unknown): boolean =>
  connection.transport.sessionId !== undefined &&
  SdkHttpError.isInstance(cause) &&
  cause.status === 404;

const authorizationRequired = (cause: unknown): boolean =>
  isAuthorizationError(cause) || (SdkHttpError.isInstance(cause) && cause.status === 403);

export class McpServerPool {
  private readonly loads = new Map<string, Promise<number>>();
  private readonly servers = new Map<string, ServerRecord>();
  private readonly shutdown = new AbortController();
  private calls = new AbortController();
  private readonly accounting = new Map<string, SamplingUsage[]>();
  private readonly persistOutput = createOutputStore();
  private readonly background = new Set<Promise<void>>();

  private readonly pi: McpToolRegistry;

  constructor(
    pi: McpToolRegistry,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.pi = pi;
  }

  hasServer(name: string): boolean {
    return this.servers.get(name)?.connection !== undefined;
  }

  async restoreServer(
    options: Omit<LoadServerOptions, "interactive" | "reconnect">,
  ): Promise<void> {
    this.shutdown.signal.throwIfAborted();
    options.signal?.throwIfAborted();

    // Restoring selection must not replace a retry loop with a one-shot connection attempt.
    if (this.servers.get(options.serverName)?.recovery) return;
    await this.loadServer({ ...options, interactive: false });
  }

  async loadServer(options: LoadServerOptions): Promise<number> {
    this.shutdown.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    let server = this.servers.get(options.serverName);

    if (!server) {
      server = {
        toolNames: [],
        registeredNames: new Set(),
        desired: true,
        maintenance: new AbortController(),
        activeCalls: 0,
        pingSupported: true,
        retryDelayMs: 0,
        recoveryWarned: false,
      };
      this.servers.set(options.serverName, server);
    }

    // Explicit loads supersede background work, but retain the per-server load queue.
    this.stopMaintenance(server);
    server.desired = true;

    try {
      return await this.enqueueLoad(options);
    } finally {
      if (server.connection) this.schedulePing(server, server.connection);
    }
  }

  private async enqueueLoad(options: LoadServerOptions): Promise<number> {
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
      const wanted = desired.has(name);

      if (server.desired !== wanted) {
        server.desired = wanted;
        this.stopMaintenance(server);

        if (wanted && server.connection) this.schedulePing(server, server.connection);
      }

      if (desired.has(name) && server.connection) active.push(...server.toolNames);
    }

    this.pi.setActiveTools([...new Set(active)]);
  }

  private disconnect(server: ServerRecord, connection: McpClientConnection): void {
    if (server.connection !== connection) return;
    clearTimeout(server.timer);
    delete server.timer;
    delete server.connection;
    this.pi.setActiveTools(
      this.pi.getActiveTools().filter((name) => !server.registeredNames.has(name)),
    );
  }

  private async load(options: LoadServerOptions, signal: AbortSignal): Promise<number> {
    const { serverName } = options;
    const server = this.servers.get(serverName);

    if (!server) throw new Error(`MCP server ${serverName} is not loaded`);

    if (server.connection && !options.reconnect) {
      if (server.desired) activateTools(this.pi, server.toolNames);
      this.schedulePing(server, server.connection);

      return server.toolNames.length;
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
            ...mcpRenderers(serverName, tool.name),
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
                const notices = [
                  `[MCP output truncated: ${formatSize(Buffer.byteLength(converted.fullText))} total text]`,
                ];

                try {
                  details.outputPath = await this.persistOutput(converted.fullText);
                  notices.push(
                    `[Persisted output: ${details.outputPath}; temporary, may be partial]`,
                  );
                } catch {
                  notices.push(
                    "[Could not persist overflow. The remote operation has already completed; do not retry solely for this warning.]",
                  );
                }

                details.overflowNoticeIndex = converted.content.length;
                converted.content.push({ type: "text", text: notices.join("\n") });
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
      server.settings = {
        serverName,
        connectionFactory: options.connectionFactory,
        ...(options.heartbeatIntervalMs !== undefined
          ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
          : {}),
        ...(options.heartbeatTimeoutMs !== undefined
          ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
          : {}),
      };
      server.pingSupported = true;
      server.connection = connection;
      server.connectedAt = Date.now();
      const record = server;
      connection.closed?.addEventListener("abort", () => this.recover(record, connection), {
        once: true,
      });

      if (server.desired) activateTools(this.pi, server.toolNames);
      this.schedulePing(server, connection);

      return tools.length;
    } catch (error) {
      await connection.close().catch(() => {
        /* Preserve the loading error. */
      });
      throw error;
    }
  }

  private stopMaintenance(server: ServerRecord): void {
    clearTimeout(server.timer);
    delete server.timer;
    server.maintenance.abort();
    server.maintenance = new AbortController();
    delete server.recovery;
  }

  private track(work: Promise<void>): void {
    this.background.add(work);
    const settled = () => this.background.delete(work);
    void work.then(settled, settled);
  }

  private schedulePing(server: ServerRecord, connection: McpClientConnection): void {
    if (server.connection !== connection) return;
    clearTimeout(server.timer);
    delete server.timer;
    const interval = server.settings?.heartbeatIntervalMs ?? 60_000;

    if (!interval || !server.pingSupported || !server.desired || this.shutdown.signal.aborted)
      return;
    server.timer = setTimeout(() => {
      delete server.timer;
      this.track(this.ping(server, connection));
    }, interval);
    server.timer.unref();
  }

  private async ping(server: ServerRecord, connection: McpClientConnection): Promise<void> {
    const signal = AbortSignal.any([this.shutdown.signal, server.maintenance.signal]);

    if (signal.aborted || !server.desired || server.connection !== connection) return;

    // Don't declare a busy server dead while it is performing a long tool call or interaction.
    if (server.activeCalls > 0) {
      this.schedulePing(server, connection);

      return;
    }

    try {
      await connection.client.ping({
        signal,
        timeout: server.settings?.heartbeatTimeoutMs ?? 10_000,
      });
      this.recordHealth(server, connection);
    } catch (error) {
      if (signal.aborted || server.connection !== connection) return;

      if (
        (ProtocolError.isInstance(error) && error.code === ProtocolErrorCode.MethodNotFound) ||
        (SdkError.isInstance(error) &&
          error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion)
      ) {
        // Some protocol eras/servers don't implement ping; don't reconnect a healthy peer forever.
        server.pingSupported = false;
      } else if (authorizationRequired(error)) {
        this.disconnect(server, connection);
        await connection.close().catch(() => {});

        if (!signal.aborted)
          this.warn(
            `MCP server ${server.settings?.serverName} requires authorization. Reconnect with /mcp or mcp_connect.`,
          );
      } else if (sessionExpired(connection, error) || server.activeCalls === 0) {
        this.recover(server, connection);
      }
    } finally {
      if (!signal.aborted) this.schedulePing(server, connection);
    }
  }

  private recordHealth(server: ServerRecord, connection: McpClientConnection): void {
    // Discovery alone isn't sustained health: a flapping peer must retain its backoff.
    if (
      server.connection === connection &&
      server.connectedAt !== undefined &&
      Date.now() - server.connectedAt >= 60_000
    ) {
      server.retryDelayMs = 0;
      server.recoveryWarned = false;
    }
  }

  private recover(server: ServerRecord, connection: McpClientConnection): void {
    if (server.connection !== connection) return;
    this.disconnect(server, connection);

    if (this.shutdown.signal.aborted) return;
    const settings = server.settings;
    const signal = AbortSignal.any([this.shutdown.signal, server.maintenance.signal]);

    const work = (async () => {
      await connection.close().catch(() => {});

      if (!settings || !server.desired || signal.aborted) return;

      // Reinitialize and rediscover only. Never replay the failed tools/call.
      while (server.desired && !signal.aborted) {
        try {
          if (server.retryDelayMs)
            await sleep(server.retryDelayMs, undefined, { signal, ref: false });
          signal.throwIfAborted();
          server.retryDelayMs = Math.min(60_000, server.retryDelayMs * 2 || 1_000);
          await this.enqueueLoad({
            ...settings,
            interactive: false,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          });

          return;
        } catch (error) {
          if (signal.aborted) return;

          if (authorizationRequired(error)) {
            this.warn(
              `MCP server ${settings.serverName} could not reconnect automatically: ${errorMessage(error)}. Use /mcp or mcp_connect to reconnect.`,
            );

            return;
          }

          if (server.retryDelayMs === 60_000 && !server.recoveryWarned) {
            server.recoveryWarned = true;
            this.warn(
              `MCP server ${settings.serverName} is still unavailable: ${errorMessage(error)}. Automatic reconnection will continue every 60 seconds while selected.`,
            );
          }
        }
      }
    })();

    server.recovery = work;

    const settled = () => {
      if (server.recovery === work) delete server.recovery;
    };

    void work.then(settled, settled);
    this.track(work);
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

    for (const server of this.servers.values()) this.stopMaintenance(server);

    const connections = [...this.servers.values()].flatMap((server) =>
      server.connection ? [server.connection] : [],
    );

    await Promise.allSettled([
      ...connections.map((connection) => connection.close()),
      ...this.loads.values(),
      ...this.background,
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
        `MCP server ${serverName} is disconnected. ${server?.recovery ? "Automatic reconnection is in progress." : "Reconnect with /mcp or mcp_connect."}`,
      );
    signal = AbortSignal.any([
      this.shutdown.signal,
      this.calls.signal,
      ...(signal ? [signal] : []),
      ...(connection.closed ? [connection.closed] : []),
    ]);
    const call = () => connection.client.callTool({ name: toolName, arguments: args }, { signal });
    server.activeCalls += 1;

    try {
      const result = await (ctx && connection.withContext
        ? connection.withContext({ ctx, model: ctx.model, signal, reportUsage }, call)
        : call());

      this.recordHealth(server, connection);

      return result;
    } catch (error) {
      signal?.throwIfAborted();
      const authorization = isAuthorizationError(error);
      const expired = sessionExpired(connection, error);

      if (!authorization && !expired) throw error;

      if (expired) {
        this.recover(server, connection);
        throw new Error(
          `MCP server ${serverName} session expired. Reconnecting automatically; the tool call was not replayed. Verify its outcome before retrying a mutating operation.`,
          { cause: error },
        );
      }

      this.disconnect(server, connection);
      await connection.close().catch(() => {
        /* Preserve the request failure. */
      });
      throw new Error(
        `MCP server ${serverName} requires authorization. Reconnect with /mcp or mcp_connect.`,
        { cause: error },
      );
    } finally {
      server.activeCalls -= 1;
    }
  }
}
