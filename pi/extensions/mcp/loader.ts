import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { resolveMcpServer, listMcpServers, loadMcpConfig } from "./config.js";
import type { McpConfig } from "./config.js";
import { connectToServer, errorMessage } from "./connection.js";
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
  const serverPool = new McpServerPool(pi);
  let managerRegistered = false;
  let restoreGeneration = 0;
  let desiredServerNames: readonly string[] = [];

  const loadNamedServer = async (
    ctx: ExtensionContext,
    serverName: string,
    options: {
      config?: Promise<McpConfig>;
      reconnect?: boolean;
      interactive: boolean;
      persist: boolean;
      signal?: AbortSignal;
    },
  ) => {
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
      const config = await (options.config ?? loadMcpConfig(configOptions(ctx)));
      const serverConfig = resolveMcpServer(config, serverName);
      toolCount = await serverPool.loadServer({
        connectionFactory: (interactive, signal) =>
          connectToServer({
            serverConfig,
            signal,
            cwd: ctx.cwd,
            onAuthorizationUrl: interactive
              ? (url) => {
                  ctx.ui.notify(
                    `Authorize MCP server ${serverName}:\n${url.href}\nWaiting for OAuth authorization...`,
                    "info",
                  );
                  if (ctx.mode === "tui" && ctx.hasUI) openBrowser(url.href);
                }
              : undefined,
          }),
        interactive: options.interactive,
        reconnect: options.reconnect,
        serverName,
        signal: options.signal,
      });
    }

    if (options.persist) {
      pi.appendEntry("mcp-server-loaded", { serverName });
    }
    return toolCount;
  };

  return {
    dispose: (): Promise<void> => serverPool.closeAll(),
    pickAndLoad: async (ctx: ExtensionCommandContext): Promise<void> => {
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
          await loadNamedServer(ctx, serverName, {
            config:
              serverName === MCP_MANAGER_SERVER_NAME
                ? undefined
                : (config ??= loadMcpConfig(configOptions(ctx))),
            interactive: false,
            persist: false,
          });
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
