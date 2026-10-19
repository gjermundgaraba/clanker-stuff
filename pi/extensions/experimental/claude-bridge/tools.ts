// Tool names and descriptions between pi and Claude Code. The query runs with
// `tools: []`, so every tool Claude can call is a pi tool served over MCP as
// `mcp__custom-tools__<pi name>`.

import type { Tool } from "@earendil-works/pi-ai";

export const MCP_SERVER_NAME = "custom-tools";

export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** A pi tool's name as Claude Code calls it. */
export const sdkToolName = (name: string): string => `${MCP_TOOL_PREFIX}${name}`;

export interface ServedTools {
  /** The tools, their descriptions carrying their guidelines. */
  tools: Tool[];
  /** Their pi names. */
  names: ReadonlySet<string>;
}

/** A tool's description followed by its prompt guidelines. Pi lists guidelines in its own
 *  system prompt, which is not forwarded, so they travel with the tool they describe. */
function describeTool(description: string, guidelines: readonly string[] = []): string {
  const bullets = guidelines.flatMap((guideline) =>
    guideline.trim() === "" ? [] : [`- ${guideline.trim()}`],
  );

  return bullets.length === 0
    ? description
    : `${description}\n\nGuidelines:\n${bullets.join("\n")}`;
}

export function resolveServedTools(
  tools: readonly Tool[],
  guidelines: ReadonlyMap<string, readonly string[]> = new Map(),
): ServedTools {
  const served = tools.map((tool) => ({
    ...tool,
    description: describeTool(tool.description, guidelines.get(tool.name)),
  }));

  return { tools: served, names: new Set(served.map((tool) => tool.name)) };
}

// Only pi tools served over MCP are legitimate, called by their exact served name. Any
// other name is the model inventing a builtin (`bash`, `Edit`, an MCP server we don't
// serve). Claude Code answers those itself with "No such tool available" and retries
// under a fresh tool_use id without dispatching to our server, so such a call must not
// reach pi: forwarding one ran a tool Claude Code never dispatched and left the retry's
// handler with no result to release it, deadlocking both sides.
export function piToolName(name: string, served: ReadonlySet<string>): string | undefined {
  const piName = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : undefined;

  return piName !== undefined && served.has(piName) ? piName : undefined;
}
