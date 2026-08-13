import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  CallToolResult,
  Client,
  Transport,
} from "@modelcontextprotocol/client";

import {
  activateTools,
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

const MAX_PERSISTED_OUTPUT_BYTES = 1024 * 1024;
const MAX_PERSISTED_OUTPUT_COUNT = 10;
const MAX_PERSISTED_OUTPUT_TOTAL_BYTES = 5 * 1024 * 1024;
const PERSISTED_OUTPUT_TRUNCATION_NOTICE = Buffer.from(
  "\n\n[MCP persisted output truncated]\n"
);

const waitForLoad = async (
  load: Promise<McpLoadResult>,
  signal?: AbortSignal
): Promise<void> => {
  if (!signal) {
    await load.catch(() => null);
    return;
  }

  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => {
    aborted.reject(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([load.catch(() => null), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const persistOverflow = async (
  serverName: string,
  toolName: string,
  content: string
): Promise<string> => {
  const directory = path.resolve(
    getExtensionStoragePaths("mcp").dataDir,
    "results"
  );
  const filePath = path.join(
    directory,
    `${Date.now()}-${randomUUID()}-${toGeneratedToolName(serverName, toolName)}.txt`
  );
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const fullOutput = Buffer.from(content);
  let persistedOutput = fullOutput;
  if (fullOutput.length > MAX_PERSISTED_OUTPUT_BYTES) {
    let end =
      MAX_PERSISTED_OUTPUT_BYTES - PERSISTED_OUTPUT_TRUNCATION_NOTICE.length;
    // oxlint-disable-next-line no-bitwise -- UTF-8 continuation bytes start with 10
    while ((fullOutput[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    persistedOutput = Buffer.concat([
      fullOutput.subarray(0, end),
      PERSISTED_OUTPUT_TRUNCATION_NOTICE,
    ]);
  }

  await withFileMutationQueue(directory, async () => {
    await mkdir(directory, { mode: 0o700, recursive: true });
    try {
      await writeFile(tempPath, persistedOutput, { mode: 0o600 });
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true });
    }

    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
        .map(async (entry) => {
          const candidatePath = path.join(directory, entry.name);
          try {
            const metadata = await stat(candidatePath, { bigint: true });
            return {
              modifiedAt: metadata.mtimeNs,
              name: entry.name,
              path: candidatePath,
              size: Number(metadata.size),
            };
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return null;
            }
            throw error;
          }
        })
    );
    const existingFiles = files.filter((file) => file !== null);
    existingFiles.sort((left, right) => {
      if (left.path === filePath) {
        return -1;
      }
      if (right.path === filePath) {
        return 1;
      }
      if (left.modifiedAt === right.modifiedAt) {
        return right.name.localeCompare(left.name);
      }
      return left.modifiedAt > right.modifiedAt ? -1 : 1;
    });

    let retainedBytes = 0;
    let pruning = false;
    for (const [index, file] of existingFiles.entries()) {
      if (
        !pruning &&
        index < MAX_PERSISTED_OUTPUT_COUNT &&
        retainedBytes + file.size <= MAX_PERSISTED_OUTPUT_TOTAL_BYTES
      ) {
        retainedBytes += file.size;
      } else {
        pruning = true;
        // oxlint-disable-next-line no-await-in-loop -- pruning shares the directory mutation queue
        await rm(file.path, { force: true });
      }
    }
  });
  return filePath;
};

export class McpServerPool {
  private readonly loads = new Map<string, Promise<McpLoadResult>>();
  private readonly reconnects = new Map<string, Promise<ConnectedServer>>();
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly shutdown = new AbortController();

  async loadServer(options: LoadServerOptions): Promise<McpLoadResult> {
    for (;;) {
      const existing = this.loads.get(options.serverName);
      if (!existing) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- each caller waits for the keyed load ahead of it
      await waitForLoad(existing, options.signal);
    }

    const load = this.load(options);
    this.loads.set(options.serverName, load);
    try {
      return await load;
    } finally {
      if (this.loads.get(options.serverName) === load) {
        this.loads.delete(options.serverName);
      }
    }
  }

  reconcileActiveServers(
    pi: ExtensionAPI,
    desiredServerNames: readonly string[]
  ): void {
    const desired = new Set(desiredServerNames);
    const managed = new Set(
      [...this.servers.values()].flatMap(({ toolNames }) => toolNames)
    );
    const desiredTools = new Set(
      [...this.servers.entries()].flatMap(([name, server]) =>
        desired.has(name) ? server.toolNames : []
      )
    );
    pi.setActiveTools([
      ...pi
        .getActiveTools()
        .filter((name) => !managed.has(name) || desiredTools.has(name)),
      ...[...desiredTools].filter(
        (name) => !pi.getActiveTools().includes(name)
      ),
    ]);
  }

  private async load(options: LoadServerOptions): Promise<McpLoadResult> {
    options.signal?.throwIfAborted();
    if (this.shutdown.signal.aborted) {
      throw new Error("MCP server pool is closed");
    }
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

    const signal = options.signal
      ? AbortSignal.any([options.signal, this.shutdown.signal])
      : this.shutdown.signal;
    const connection = await connectionFactory(options.interactive, signal);
    try {
      signal.throwIfAborted();
      const result = await this.registerMcpTools(
        options.pi,
        options.serverName,
        connection.client,
        signal
      );
      signal.throwIfAborted();
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
    if (this.shutdown.signal.aborted) {
      return;
    }
    this.shutdown.abort();
    const closeConnections = [...this.servers.values()].map(({ close }) =>
      close()
    );
    const pending = [...this.loads.values(), ...this.reconnects.values()];
    this.servers.clear();
    await Promise.allSettled([...closeConnections, ...pending]);
  }

  private async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<CallToolResult> {
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
      const connection = await stale.connectionFactory(
        false,
        this.shutdown.signal
      );
      try {
        this.shutdown.signal.throwIfAborted();
        if (this.servers.get(serverName) !== stale) {
          throw new Error(`MCP server ${serverName} is not connected`);
        }
        const replacement = { ...stale, ...connection };
        this.servers.set(serverName, replacement);
        await stale.close().catch(() => {
          // The replacement connection is already active.
        });
        return replacement;
      } catch (error) {
        await connection.close().catch(() => {
          // Preserve the reconnect error that triggered cleanup.
        });
        throw error;
      }
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
          let converted = mcpResultToPiContent(result);
          let outputPath: string | undefined;
          if (converted.truncated) {
            outputPath = await persistOverflow(
              serverName,
              tool.name,
              converted.fullText
            );
            converted = mcpResultToPiContent(result, outputPath);
          }
          if (result.isError === true) {
            // oxlint-disable-next-line unicorn/prefer-type-error -- this reports a remote tool failure, not invalid argument types
            throw new Error(
              `MCP tool ${tool.name} from server ${serverName} returned an error: ${converted.content
                .map((item) =>
                  item.type === "text" ? item.text : `[image:${item.mimeType}]`
                )
                .join("\n")}`
            );
          }
          return {
            content: converted.content,
            details: {
              serverName,
              toolName: tool.name,
              truncated: converted.truncated,
              ...(outputPath === undefined ? {} : { outputPath }),
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
