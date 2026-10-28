import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import type { McpSkills } from "./runtime.js";

export const checkResourceRead = async (
  skills: McpSkills,
  event: ToolCallEvent,
  ctx: ExtensionContext
): Promise<ToolCallEventResult | undefined> => {
  if (event.toolName !== "read_mcp_resource") {
    return undefined;
  }

  const server = "server" in event.input ? event.input["server"] : undefined;

  if (typeof server !== "string") {
    return undefined;
  }

  const others = [...skills.serversInUse(ctx)].filter(
    (source) => source !== server
  );

  if (others.length === 0) {
    return undefined;
  }

  const question = `Read a resource from MCP server "${inlineText(server)}" while skills from MCP server ${others.map((source) => `"${source}"`).join(", ")} are in use?`;

  if (
    ctx.hasUI &&
    (await ctx.ui.confirm("Cross-server resource read", question))
  ) {
    return undefined;
  }

  return { block: true, reason: `${question} Not approved.` };
};
