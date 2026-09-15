import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { resolveMcpServer, listMcpServers, loadMcpConfig } from "./config.js";
import type { McpConfig } from "./config.js";
import { connectToServer, errorMessage } from "./connection.js";
import type { McpConnectionFactory } from "./connection.js";
import { loadedServerNames } from "./loaded-servers.js";
import {
  configOptions,
  registerManagerTools,
  MANAGER_TOOL_NAMES,
  MCP_MANAGER_SERVER_NAME,
} from "./manager.js";
import { activateTools } from "./bridge.js";
import { openBrowser } from "./open-browser.js";
import { McpServerPool } from "./servers.js";
import { sumUsage } from "./sampling.js";

type LoaderResult<T> = { type: "ok"; value: T } | { type: "error"; error: unknown };

const loadServerWithSpinner = async <T>(
  ctx: ExtensionCommandContext,
  serverName: string,
  load: (signal?: AbortSignal) => Promise<T>,
): Promise<T> => {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    return await load();
  }

  const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `Loading MCP server ${serverName} tools...`);
    void (async () => {
      try {
        const value = await load(loader.signal);
        done({ type: "ok", value });
      } catch (error) {
        done({ error, type: "error" });
      }
    })();
    return loader;
  });

  if (result.type === "error") {
    throw result.error;
  }
  return result.value;
};

interface McpManagerListResult {
  names: string[];
  error?: string;
}

const listAvailableServers = async (ctx: ExtensionContext): Promise<McpManagerListResult> => {
  try {
    const configured = await listMcpServers(configOptions(ctx));
    return {
      names: [
        MCP_MANAGER_SERVER_NAME,
        ...configured.map(({ name }) => name).filter((name) => name !== MCP_MANAGER_SERVER_NAME),
      ],
    };
  } catch (error) {
    return {
      error: `Failed to load MCP config: ${errorMessage(error)}`,
      names: [MCP_MANAGER_SERVER_NAME],
    };
  }
};

export const createMcpLoader = (pi: ExtensionAPI) => {
  let context: ExtensionContext | undefined;
  const serverPool = new McpServerPool(pi, (message) => context?.ui.notify(message, "warning"));
  let workspace: string | undefined;
  let managerRegistered = false;
  let restoreGeneration = 0;
  let desiredServerNames: readonly string[] = [];

  const resolveServerOptions = async (
    ctx: ExtensionContext,
    serverName: string,
    config?: Promise<McpConfig>,
  ) => {
    const cwd = ctx.cwd;
    const serverConfig = resolveMcpServer(
      await (config ?? loadMcpConfig(configOptions(ctx))),
      serverName,
    );
    const connectionFactory: McpConnectionFactory = (interactive, signal) =>
      connectToServer({
        serverConfig,
        pi,
        serverName,
        signal,
        cwd,
        getWorkspace: () => workspace,
        onAuthorizationUrl: interactive
          ? (url) => {
              ctx.ui.notify(
                `Authorize MCP server ${serverName}:\n${url.href}\nWaiting for OAuth authorization...`,
                "info",
              );
              if (ctx.mode === "tui" && ctx.hasUI) openBrowser(url.href);
            }
          : undefined,
      });
    return {
      connectionFactory,
      heartbeatIntervalMs: serverConfig.heartbeatIntervalMs,
      heartbeatTimeoutMs: serverConfig.heartbeatTimeoutMs,
      serverName,
    };
  };

  const loadNamedServer = async (
    ctx: ExtensionContext,
    serverName: string,
    options: {
      reconnect?: boolean;
      interactive: boolean;
      persist: boolean;
      signal?: AbortSignal;
    },
  ) => {
    context = ctx;
    let toolCount: number;
    if (serverName === MCP_MANAGER_SERVER_NAME) {
      if (!managerRegistered) {
        registerManagerTools(pi, (executeCtx, name, reconnect, signal) =>
          loadNamedServer(executeCtx, name, {
            interactive: executeCtx.hasUI,
            persist: true,
            reconnect,
            signal,
          }),
        );
        managerRegistered = true;
      }
      activateTools(pi, MANAGER_TOOL_NAMES);
      toolCount = MANAGER_TOOL_NAMES.length;
    } else {
      toolCount = await serverPool.loadServer({
        ...(await resolveServerOptions(ctx, serverName)),
        interactive: options.interactive,
        reconnect: options.reconnect,
        signal: options.signal,
      });
    }

    if (options.persist) {
      pi.appendEntry("mcp-server-loaded", { serverName });
    }
    return toolCount;
  };

  return {
    toolResult: (id: string, details: unknown) => {
      const samples = serverPool.takeUsage(id);
      return samples
        ? {
            usage: sumUsage(samples),
            details: {
              ...detailsForUsage(details),
              sampling: samples,
            },
          }
        : undefined;
    },
    dispose: (): Promise<void> => {
      context = undefined;
      workspace = undefined;
      return serverPool.closeAll();
    },
    pickAndLoad: async (ctx: ExtensionCommandContext): Promise<void> => {
      workspace = ctx.cwd;
      const available = await listAvailableServers(ctx);
      if (available.error) {
        ctx.ui.notify(available.error, "error");
      }

      const branchServerNames = new Set(loadedServerNames(ctx.sessionManager.getBranch()));
      const serverOptions = available.names.map((name) => {
        const active =
          branchServerNames.has(name) &&
          (name === MCP_MANAGER_SERVER_NAME ? managerRegistered : serverPool.hasServer(name));
        return {
          label: active
            ? `● ${name} (${name === MCP_MANAGER_SERVER_NAME ? "active" : "reconnect"})`
            : `○ ${name}`,
          name,
        };
      });
      const selected = await ctx.ui.select(
        "MCP server",
        serverOptions.map(({ label }) => label),
      );
      const serverName = serverOptions.find(({ label }) => label === selected)?.name;
      if (serverName === undefined) {
        return;
      }

      try {
        const toolCount = await loadServerWithSpinner(ctx, serverName, (signal) =>
          loadNamedServer(ctx, serverName, {
            interactive: ctx.hasUI,
            persist: true,
            reconnect: serverName !== MCP_MANAGER_SERVER_NAME,
            signal,
          }),
        );
        ctx.ui.notify(`MCP server ${serverName} was loaded with ${toolCount} tools`);
      } catch (error) {
        ctx.ui.notify(`Failed to load MCP server ${serverName}: ${errorMessage(error)}`, "error");
      }
    },
    restore: async (ctx: ExtensionContext): Promise<void> => {
      context = ctx;
      workspace = ctx.cwd;
      serverPool.cancelCalls();
      restoreGeneration += 1;
      const generation = restoreGeneration;
      const names = loadedServerNames(ctx.sessionManager.getBranch());
      if (managerRegistered && !names.includes(MCP_MANAGER_SERVER_NAME))
        pi.setActiveTools(pi.getActiveTools().filter((name) => !MANAGER_TOOL_NAMES.includes(name)));
      let config: Promise<McpConfig> | undefined;
      desiredServerNames = names;
      serverPool.reconcileActiveServers(names);
      for (const serverName of names) {
        if (generation !== restoreGeneration) {
          serverPool.reconcileActiveServers(desiredServerNames);
          return;
        }
        try {
          if (serverName === MCP_MANAGER_SERVER_NAME) {
            await loadNamedServer(ctx, serverName, { interactive: false, persist: false });
          } else {
            await serverPool.restoreServer(
              await resolveServerOptions(
                ctx,
                serverName,
                (config ??= loadMcpConfig(configOptions(ctx))),
              ),
            );
          }
        } catch (error) {
          ctx.ui.notify(
            `Could not restore MCP server ${serverName}: ${errorMessage(error)}. Use /mcp to reconnect.`,
            "warning",
          );
        }
      }
      serverPool.reconcileActiveServers(desiredServerNames);
    },
  };
};

const detailsForUsage = (details: unknown): object | undefined =>
  typeof details === "object" && details !== null ? details : undefined;
