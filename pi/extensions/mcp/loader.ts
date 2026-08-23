import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import {
  addMcpServer,
  listMcpServers,
  loadMcpConfig,
  removeMcpServer,
} from "./config.js";
import type { McpConfig } from "./config.js";
import { connectToServer, errorMessage } from "./connection.js";
import { loadedServerNames } from "./loaded-servers.js";
import {
  createMcpManagerConnection,
  MCP_MANAGER_SERVER_NAME,
} from "./manager.js";
import type { McpManagerBackend, McpManagerListResult } from "./manager.js";
import { McpServerPool } from "./servers.js";

type LoaderResult<T> =
  | { type: "ok"; value: T }
  | { type: "error"; error: unknown };

const loadServerWithSpinner = async <T>(
  ctx: ExtensionCommandContext,
  serverName: string,
  load: (signal?: AbortSignal) => Promise<T>
): Promise<T> => {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    return await load();
  }

  const result = await ctx.ui.custom<LoaderResult<T>>(
    (tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Loading MCP server ${serverName} tools...`
      );
      void (async () => {
        try {
          const value = await load(loader.signal);
          done({ type: "ok", value });
        } catch (error) {
          done({ error, type: "error" });
        }
      })();
      return loader;
    }
  );

  if (result.type === "error") {
    throw result.error;
  }
  return result.value;
};

const configOptions = (ctx: ExtensionContext) => ({
  cwd: ctx.cwd,
  projectTrusted: ctx.isProjectTrusted(),
});

const listAvailableServers = async (
  ctx: ExtensionContext,
  signal?: AbortSignal
): Promise<McpManagerListResult> => {
  signal?.throwIfAborted();
  const manager = {
    name: MCP_MANAGER_SERVER_NAME,
    scope: "built-in" as const,
  };
  try {
    const configured = await listMcpServers(configOptions(ctx));
    return {
      servers: [
        manager,
        ...configured.filter(({ name }) => name !== MCP_MANAGER_SERVER_NAME),
      ],
    };
  } catch (error) {
    return {
      error: `Failed to load MCP config: ${errorMessage(error)}`,
      servers: [manager],
    };
  }
};

export const createMcpLoader = (pi: ExtensionAPI) => {
  const serverPool = new McpServerPool();
  let restoreGeneration = 0;
  let desiredServerNames: readonly string[] = [];

  const loadNamedServer = async (
    ctx: ExtensionContext,
    serverName: string,
    options: {
      config?: Promise<McpConfig>;
      interactive: boolean;
      persist: boolean;
      signal?: AbortSignal;
    }
  ) => {
    let result;
    if (serverName === MCP_MANAGER_SERVER_NAME) {
      const backend: McpManagerBackend = {
        add: async (name, serverConfig, scope, signal) => {
          signal.throwIfAborted();
          if (name === MCP_MANAGER_SERVER_NAME) {
            throw new Error(
              `MCP server name ${MCP_MANAGER_SERVER_NAME} is reserved`
            );
          }
          await addMcpServer(name, serverConfig, scope, configOptions(ctx));
        },
        connect: async (name, signal) => {
          const loaded = await loadNamedServer(ctx, name, {
            interactive: ctx.hasUI,
            persist: true,
            signal,
          });
          return loaded.toolCount;
        },
        list: (signal) => listAvailableServers(ctx, signal),
        remove: async (name, scope, signal) => {
          signal.throwIfAborted();
          await removeMcpServer(name, scope, configOptions(ctx));
        },
      };
      result = await serverPool.loadServer({
        connectionFactory: (_interactive, signal) =>
          createMcpManagerConnection(backend, signal),
        interactive: options.interactive,
        pi,
        serverName,
        signal: options.signal,
      });
    } else {
      const config = await (options.config ??
        loadMcpConfig(configOptions(ctx)));
      const serverConfig = config.mcpServers[serverName];
      if (serverConfig === undefined) {
        throw new Error(`MCP server ${serverName} is not configured`);
      }
      result = await serverPool.loadServer({
        connectionFactory: (interactive, signal) =>
          connectToServer(
            serverName,
            serverConfig,
            ctx.ui,
            interactive,
            signal
          ),
        interactive: options.interactive,
        pi,
        serverName,
        signal: options.signal,
      });
    }

    if (options.persist) {
      pi.appendEntry("mcp-server-loaded", { serverName });
    }
    return result;
  };

  return {
    dispose: (): Promise<void> => serverPool.closeAll(),
    pickAndLoad: async (ctx: ExtensionCommandContext): Promise<void> => {
      const available = await listAvailableServers(ctx);
      if (available.error !== undefined && available.error !== "") {
        ctx.ui.notify(available.error, "error");
      }

      const branchServerNames = new Set(
        loadedServerNames(ctx.sessionManager.getBranch())
      );
      const serverOptions = available.servers.map(({ name }) => {
        const active =
          branchServerNames.has(name) && serverPool.hasServer(name);
        return {
          label: active ? `● ${name} (active)` : `○ ${name}`,
          name,
        };
      });
      const selected = await ctx.ui.select(
        "MCP server",
        serverOptions.map(({ label }) => label)
      );
      const serverName = serverOptions.find(
        ({ label }) => label === selected
      )?.name;
      if (serverName === undefined) {
        return;
      }

      try {
        const result = await loadServerWithSpinner(ctx, serverName, (signal) =>
          loadNamedServer(ctx, serverName, {
            interactive: true,
            persist: true,
            signal,
          })
        );
        ctx.ui.notify(
          `MCP server ${serverName} was loaded with ${result.toolCount} tools`
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to load MCP server ${serverName}: ${errorMessage(error)}`,
          "error"
        );
      }
    },
    restore: async (ctx: ExtensionContext): Promise<void> => {
      restoreGeneration += 1;
      const generation = restoreGeneration;
      const names = loadedServerNames(ctx.sessionManager.getBranch());
      let config: Promise<McpConfig> | undefined;
      desiredServerNames = names;
      serverPool.reconcileActiveServers(pi, names);
      for (const serverName of names) {
        if (generation !== restoreGeneration) {
          serverPool.reconcileActiveServers(pi, desiredServerNames);
          return;
        }
        try {
          // oxlint-disable-next-line no-await-in-loop -- registrations mutate shared tool state
          await loadNamedServer(ctx, serverName, {
            config:
              serverName === MCP_MANAGER_SERVER_NAME
                ? undefined
                : (config ??= loadMcpConfig(configOptions(ctx))),
            interactive: false,
            persist: false,
          });
        } catch {
          // The explicit /mcp command remains the interactive recovery path.
        }
      }
      serverPool.reconcileActiveServers(pi, desiredServerNames);
    },
  };
};
