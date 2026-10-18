import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

import type { McpSkills } from "./runtime.js";

/**
 * Pi's `read_mcp_resource` while MCP skills are in use: a resource of another server than theirs
 * needs the user's approval for that call; without a UI it is blocked.
 */
export const checkResourceRead = async (
  skills: McpSkills,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> => {
  if (event.toolName !== "read_mcp_resource") return undefined;

  const server = "server" in event.input ? event.input.server : undefined;

  if (typeof server !== "string") return undefined;

  const others = [...skills.serversInUse(ctx)].filter((source) => source !== server);

  if (others.length === 0) return undefined;

  const question = `Read a resource from MCP server "${inlineText(server)}" while skills from MCP server ${others.map((source) => `"${source}"`).join(", ")} are in use?`;

  if (ctx.hasUI && (await ctx.ui.confirm("Cross-server resource read", question))) return undefined;

  return { block: true, reason: `${question} Not approved.` };
};
