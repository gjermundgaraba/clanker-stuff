import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { loadMcpConfig } from "./config.js";
import type { McpConfig } from "./config.js";
import { errorMessage, McpRuntime } from "./runtime.js";

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
        `Loading MCP server ${serverName} tools...`,
        { cancellable: false }
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

export default function mcp(pi: ExtensionAPI) {
  const runtime = new McpRuntime();

  pi.registerCommand("mcp", {
    description: "Load MCP server tools",
    handler: async (_args, ctx) => {
      let config: McpConfig;
      try {
        config = await loadMcpConfig({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
      } catch (error) {
        ctx.ui.notify(
          `Failed to load MCP config: ${errorMessage(error)}`,
          "error"
        );
        return;
      }

      const serverNames = Object.keys(config.mcpServers);
      if (serverNames.length === 0) {
        ctx.ui.notify("No MCP servers configured.", "info");
        return;
      }

      const serverName = await ctx.ui.select("MCP server", serverNames);
      if (serverName === undefined || serverName === "") {
        return;
      }

      try {
        const result = await loadServerWithSpinner(ctx, serverName, (signal) =>
          runtime.loadServer({
            interactive: true,
            pi,
            serverConfig: config.mcpServers[serverName],
            serverName,
            signal,
            ui: ctx.ui,
          })
        );
        pi.appendEntry("mcp-server-loaded", { serverName });
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

    let config: McpConfig;
    try {
      config = await loadMcpConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
    } catch {
      return;
    }

    for (const serverName of names) {
      const serverConfig = config.mcpServers[serverName];
      if (serverConfig === undefined) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- registrations mutate shared tool state
        await runtime.loadServer({
          interactive: false,
          pi,
          serverConfig,
          serverName,
          ui: ctx.ui,
        });
      } catch {
        // The explicit /mcp command remains the interactive recovery path.
      }
    }
  });

  pi.on("session_shutdown", () => runtime.closeAll());
}
