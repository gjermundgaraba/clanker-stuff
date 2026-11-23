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
  /** The tool's parameters as JSON Schema, a defaulted argument described by its
   *  default. */
  inputSchema: JsonObject;
}

export interface ServedTools {
  tools: ServedTool[];
  names: ReadonlySet<string>;
  /** Per tool, the arguments a call that leaves them out gets, where the tool's schema
   *  takes them: defaults Claude Code's own tools apply and pi's do not. Claude Code's
   *  Bash stops a command after 120 seconds, and the model writes its calls expecting
   *  that, while pi's bash runs it unbounded. */
  argumentDefaults: ReadonlyMap<string, JsonObject>;
}

interface ArgumentDefault {
  value: number;
  description: string;
}

const CLAUDE_CODE_ARGUMENT_DEFAULTS = new Map<
  string,
  Readonly<Record<string, ArgumentDefault>>
>([
  [
    "bash",
    {
      timeout: {
        value: 120,
        description:
          "Timeout in seconds. A call that sets none stops after 120 seconds.",
      },
    },
  ],
]);

const takenDefaults = (
  name: string,
  properties: JsonObject
): Array<[string, ArgumentDefault]> =>
  Object.entries(CLAUDE_CODE_ARGUMENT_DEFAULTS.get(name) ?? {}).filter(
    ([key]) => isJsonObject(properties[key])
  );

interface ResolvedTool {
  served: ServedTool;
  defaults: JsonObject | undefined;
}

const serve = (tool: Tool, description: string): ResolvedTool => {
  const schema = toJsonObject(tool.parameters) ?? {};

  const properties = isJsonObject(schema["properties"])
    ? schema["properties"]
    : {};

  const taken = takenDefaults(tool.name, properties);

  if (taken.length === 0) {
    return {
      served: { name: tool.name, description, inputSchema: schema },
      defaults: undefined,
    };
  }

  const described: JsonObject = { ...properties };

  for (const [key, { description: text }] of taken) {
    const property = properties[key];

    if (isJsonObject(property)) {
      described[key] = { ...property, description: text };
    }
  }

  return {
    served: {
      name: tool.name,
      description,
      inputSchema: { ...schema, properties: described },
    },
    defaults: Object.fromEntries(taken.map(([key, { value }]) => [key, value])),
  };
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

  const resolved = tools.map((tool) =>
    serve(tool, describeTool(tool.description, guidelines.get(tool.name)))
  );

  return {
    tools: resolved.map(({ served }) => served),
    names: new Set(tools.map((tool) => tool.name)),
    argumentDefaults: new Map(
      resolved.flatMap(({ served, defaults }) =>
        defaults === undefined ? [] : [[served.name, defaults] as const]
      )
    ),
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
