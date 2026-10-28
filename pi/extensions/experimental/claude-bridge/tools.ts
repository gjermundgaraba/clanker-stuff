import type { Tool } from "@earendil-works/pi-ai";

export const MCP_SERVER_NAME = "custom-tools";

export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** A pi tool's name as Claude Code calls it. */
export const sdkToolName = (name: string): string =>
  `${MCP_TOOL_PREFIX}${name}`;

export interface ServedTools {
  /** The tools, their descriptions carrying their guidelines. */
  tools: Tool[];
  /** Their pi names. */
  names: ReadonlySet<string>;
}

const describeTool = (
  description: string,
  guidelines: readonly string[] = []
): string => {
  const bullets = guidelines.flatMap((guideline) =>
    guideline.trim() === "" ? [] : [`- ${guideline.trim()}`]
  );

  return bullets.length === 0
    ? description
    : `${description}\n\nGuidelines:\n${bullets.join("\n")}`;
};

export const resolveServedTools = (
  tools: readonly Tool[],
  guidelines: ReadonlyMap<string, readonly string[]> = new Map()
): ServedTools => {
  const served = tools.map((tool) => ({
    ...tool,
    description: describeTool(tool.description, guidelines.get(tool.name)),
  }));

  return { tools: served, names: new Set(served.map((tool) => tool.name)) };
};

export const piToolName = (
  name: string,
  served: ReadonlySet<string>
): string | undefined => {
  const piName = name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : undefined;

  return piName !== undefined && served.has(piName) ? piName : undefined;
};
