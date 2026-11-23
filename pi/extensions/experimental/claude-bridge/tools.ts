import type { JsonObject, Tool } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { isJsonObject, toJsonObject } from "./json.js";

export const MCP_SERVER_NAME = "custom-tools";

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** A pi tool's name as Claude Code calls it. */
export const sdkToolName = (name: string): string =>
  `${MCP_TOOL_PREFIX}${name}`;

/** A pi tool as the bridge's MCP server serves it to Claude Code. */
export interface ServedTool {
  name: string;
  /** The tool's description, carrying its prompt guidelines. */
  description: string;
  /** The tool's parameters as JSON Schema, `bash`'s timeout described by the bridge's
   *  default. */
  inputSchema: JsonObject;
}

export interface ServedTools {
  tools: ServedTool[];
  names: ReadonlySet<string>;
}

/** The timeout a claude-bridge `bash` call that sets none gets. Claude Code's Bash stops
 *  a command after 120 seconds, and Claude writes its calls expecting that, while pi's
 *  bash runs one unbounded. */
export const BASH_TIMEOUT_SECONDS = 120;

const BASH_TIMEOUT_DESCRIPTION = `Timeout in seconds. A call that sets none stops after ${BASH_TIMEOUT_SECONDS} seconds.`;

const inputSchema = (tool: Tool): JsonObject => {
  const schema = toJsonObject(tool.parameters) ?? {};
  const { properties } = schema;

  if (tool.name !== "bash" || !isJsonObject(properties)) {
    return schema;
  }

  const { timeout } = properties;

  return isJsonObject(timeout)
    ? {
        ...schema,
        properties: {
          ...properties,
          timeout: { ...timeout, description: BASH_TIMEOUT_DESCRIPTION },
        },
      }
    : schema;
};

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
  piTools: ReadonlyArray<Pick<ToolInfo, "name" | "promptGuidelines">> = []
): ServedTools => {
  const guidelines = new Map(
    piTools.map((tool) => [tool.name, tool.promptGuidelines])
  );

  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: describeTool(tool.description, guidelines.get(tool.name)),
      inputSchema: inputSchema(tool),
    })),
    names: new Set(tools.map((tool) => tool.name)),
  };
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
