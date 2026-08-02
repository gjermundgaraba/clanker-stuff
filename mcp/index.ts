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
import { errorMessage } from "./connection.js";
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

const loadedServerNames = (branch: readonly unknown[]): string[] => {
  const names = new Set<string>();
  for (const candidate of branch) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("type" in candidate) ||
      candidate.type !== "custom" ||
      !("customType" in candidate) ||
      candidate.customType !== "mcp-server-loaded" ||
      !("data" in candidate) ||
      typeof candidate.data !== "object" ||
      candidate.data === null ||
      !("serverName" in candidate.data) ||
      typeof candidate.data.serverName !== "string" ||
      candidate.data.serverName === ""
    ) {
      continue;
    }
    names.add(candidate.data.serverName);
  }
  return [...names];
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

export default function mcp(pi: ExtensionAPI) {
  const serverPool = new McpServerPool();

  const loadNamedServer = async (
    ctx: ExtensionContext,
    serverName: string,
    options: {
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
        list: async (signal) => await listAvailableServers(ctx, signal),
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
        ui: ctx.ui,
      });
    } else {
      const config = await loadMcpConfig(configOptions(ctx));
      const serverConfig = config.mcpServers[serverName];
      if (serverConfig === undefined) {
        throw new Error(`MCP server ${serverName} is not configured`);
      }
      result = await serverPool.loadServer({
        interactive: options.interactive,
        pi,
        serverConfig,
        serverName,
        signal: options.signal,
        ui: ctx.ui,
      });
    }

    if (options.persist) {
      pi.appendEntry("mcp-server-loaded", { serverName });
    }
    return result;
  };

  pi.registerCommand("mcp", {
    description: "Load MCP server tools",
    handler: async (_args, ctx) => {
      const available = await listAvailableServers(ctx);
      if (available.error !== undefined && available.error !== "") {
        ctx.ui.notify(available.error, "error");
      }

      const serverNames = available.servers.map(({ name }) => name);
      const serverName = await ctx.ui.select("MCP server", serverNames);
      if (serverName === undefined || serverName === "") {
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
  });

  pi.on("session_start", async (_event, ctx) => {
    const names = loadedServerNames(ctx.sessionManager.getBranch());
    if (names.length === 0) {
      return;
    }

    for (const serverName of names) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- registrations mutate shared tool state
        await loadNamedServer(ctx, serverName, {
          interactive: false,
          persist: false,
        });
      } catch {
        // The explicit /mcp command remains the interactive recovery path.
      }
    }
  });

  pi.on("session_shutdown", () => serverPool.closeAll());
}
