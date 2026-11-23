import type { JsonObject, Tool } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { isJsonObject, toJsonObject } from "./json.js";

export const MCP_SERVER_NAME = "custom-tools";

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** A pi tool's name as Claude Code calls it. */
export const sdkToolName = (name: string): string =>
  `${MCP_TOOL_PREFIX}${name}`;

export interface ServedTools {
  /** The tools, their descriptions carrying their guidelines. */
  tools: Tool[];
  names: ReadonlySet<string>;
  /** Per tool, the arguments a call that leaves them out gets, where the tool's schema
   *  takes them: defaults Claude Code's own tools apply and pi's do not. Claude Code's
   *  Bash stops a command after 120 seconds, and the model writes its calls expecting
   *  that, while pi's bash runs it unbounded. */
  argumentDefaults: ReadonlyMap<string, JsonObject>;
}

const CLAUDE_CODE_ARGUMENT_DEFAULTS = new Map<string, JsonObject>([
  ["bash", { timeout: 120 }],
]);

const defaultsTakenBy = (tool: Tool): JsonObject | undefined => {
  const defaults = CLAUDE_CODE_ARGUMENT_DEFAULTS.get(tool.name);
  const properties = toJsonObject(tool.parameters)?.["properties"];

  if (defaults === undefined || !isJsonObject(properties)) {
    return undefined;
  }

  const taken = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => key in properties)
  );

  return Object.keys(taken).length === 0 ? undefined : taken;
};

/** `args` with the tool's argument defaults filled in where the call left them out. */
export const withArgumentDefaults = (
  served: Pick<ServedTools, "argumentDefaults">,
  name: string,
  args: JsonObject
): JsonObject => {
  const defaults = served.argumentDefaults.get(name);

  return defaults === undefined ? args : { ...defaults, ...args };
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

  const served = tools.map((tool) => ({
    ...tool,
    description: describeTool(tool.description, guidelines.get(tool.name)),
  }));

  const argumentDefaults = new Map(
    served.flatMap((tool) => {
      const defaults = defaultsTakenBy(tool);

      return defaults === undefined ? [] : [[tool.name, defaults] as const];
    })
  );

  return {
    tools: served,
    names: new Set(served.map((tool) => tool.name)),
    argumentDefaults,
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
