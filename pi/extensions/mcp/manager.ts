import { mcpRenderers } from "./renderers.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { setMcpServer, listMcpServers, removeMcpServer, ServerConfigSchema } from "./config.js";

export const MCP_MANAGER_SERVER_NAME = "mcp-manager";

export const MANAGER_TOOL_NAMES = ["mcp_set", "mcp_remove", "mcp_list", "mcp_connect"];

const ScopeSchema = StringEnum(["global", "project"] as const);

const NameSchema = Type.String({ minLength: 1 });

// Lookup tools keep purely structural schemas so strict sampling can represent
// them on every provider; an unknown or empty name simply matches no server.
const STRICT_PREFERRED = { type: "json_schema", strict: "prefer" } as const;

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export const configOptions = (ctx: ExtensionContext) => ({
  cwd: ctx.cwd,
  projectTrusted: ctx.isProjectTrusted(),
});

type Connect = (
  ctx: ExtensionContext,
  name: string,
  reconnect: boolean,
  signal?: AbortSignal,
) => Promise<number>;

export const registerManagerTools = (pi: ExtensionAPI, connect: Connect): void => {
  const collision = pi.getAllTools().find(({ name }) => MANAGER_TOOL_NAMES.includes(name));

  if (collision) throw new Error(`MCP manager tool name collision: ${collision.name}`);
  pi.registerTool({
    name: "mcp_set",
    ...mcpRenderers(MCP_MANAGER_SERVER_NAME, "mcp_set", true),
    label: "Set MCP server",
    description:
      "Create or replace a complete MCP server entry in global or trusted project configuration. Does not reload an active connection. Prefer environment placeholders over literal secrets.",
    parameters: Type.Object(
      { name: NameSchema, scope: ScopeSchema, config: ServerConfigSchema },
      { additionalProperties: false },
    ),
    async execute(_id, args, signal, _update, ctx) {
      if (args.name === MCP_MANAGER_SERVER_NAME)
        throw new Error(`MCP server name ${MCP_MANAGER_SERVER_NAME} is reserved`);
      await setMcpServer(args.name, args.config, args.scope, configOptions(ctx), signal);

      return textResult(`Set MCP server ${args.name} to the ${args.scope} config`);
    },
  });
  pi.registerTool({
    name: "mcp_remove",
    ...mcpRenderers(MCP_MANAGER_SERVER_NAME, "mcp_remove", true),
    label: "Remove MCP server",
    description:
      "Remove an MCP server from configuration; already absent is success. Does not unload already active tools.",
    parameters: Type.Object(
      { name: Type.String(), scope: ScopeSchema },
      { additionalProperties: false },
    ),
    constrainedSampling: STRICT_PREFERRED,
    async execute(_id, args, signal, _update, ctx) {
      await removeMcpServer(args.name, args.scope, configOptions(ctx), signal);

      return textResult(`MCP server ${args.name} is absent from the ${args.scope} config`);
    },
  });
  pi.registerTool({
    name: "mcp_list",
    ...mcpRenderers(MCP_MANAGER_SERVER_NAME, "mcp_list", true),
    label: "List MCP servers",
    description:
      "List configured MCP servers and validation diagnostics without exposing configuration or secrets.",
    parameters: Type.Object({}, { additionalProperties: false }),
    constrainedSampling: STRICT_PREFERRED,
    async execute(_id, _args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const servers = await listMcpServers(configOptions(ctx));

      return textResult(
        [
          `${MCP_MANAGER_SERVER_NAME} (built-in)`,
          ...servers
            .filter(({ name }) => name !== MCP_MANAGER_SERVER_NAME)
            .map(({ name, scope, error }) => `${name} (${scope})${error ? `: ${error}` : ""}`),
        ].join("\n"),
      );
    },
  });
  pi.registerTool({
    name: "mcp_connect",
    ...mcpRenderers(MCP_MANAGER_SERVER_NAME, "mcp_connect", true),
    label: "Connect MCP server",
    description:
      "Connect an MCP server and activate its tools. Set reconnect to replace a broken connection, reauthorize, or refresh tools/configuration. Never retry an uncertain mutating tool call automatically.",
    parameters: Type.Object(
      { name: Type.String(), reconnect: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    constrainedSampling: STRICT_PREFERRED,
    async execute(_id, args, signal, _update, ctx) {
      const count = await connect(ctx, args.name, args.reconnect ?? false, signal);

      return textResult(`MCP server ${args.name} was loaded with ${count} tools`);
    },
  });
};
