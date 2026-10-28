import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type {
  JsonObject,
  JsonValue,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { acceptedImageType, IMAGE_MARKER } from "./images.js";
import { isJsonArray, isJsonObject } from "./json.js";

const TOOL_USE_ID_META = "claudecode/toolUseId";

export type McpContent = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;

export interface McpResult {
  content: McpContent;
  isError?: boolean;
}

export const toolResultToMcpContent = (
  content: ToolResultMessage["content"]
): McpContent => {
  const blocks: McpContent = [];

  for (const block of content) {
    if (block.type === "text") {
      if (block.text !== "") {
        blocks.push({ type: "text", text: block.text });
      }
    } else {
      const mimeType = acceptedImageType(block);

      blocks.push(
        mimeType === undefined
          ? { type: "text", text: IMAGE_MARKER }
          : { type: "image", data: block.data, mimeType }
      );
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
};

export interface McpToolDef {
  name: string;
  description: string;
  /** The tool's JSON Schema: pi's TypeBox parameters as plain JSON. */
  inputSchema: JsonObject;
  handler: (toolCallId: string) => Promise<McpResult>;
}

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

type RootCombinator = (typeof ROOT_COMBINATORS)[number];

const resolveLocalRef = (branch: JsonValue, root: JsonObject): JsonValue => {
  if (!isJsonObject(branch) || typeof branch["$ref"] !== "string") {
    return branch;
  }

  const match = /^#\/(?<section>\$defs|definitions)\/(?<name>[^/]+)$/u.exec(
    branch["$ref"]
  );

  const section = match?.groups?.["section"];
  const defs = section === undefined ? undefined : root[section];
  const name = match?.groups?.["name"];

  const target =
    isJsonObject(defs) && name !== undefined ? defs[name] : undefined;

  return isJsonObject(target) ? target : branch;
};

const branchGroup = (branch: JsonValue): string | undefined => {
  if (!isJsonObject(branch)) {
    return undefined;
  }

  const { required, properties } = branch;

  if (
    isJsonArray(required) &&
    required.length > 0 &&
    required.every((key) => typeof key === "string")
  ) {
    return required.join(", ");
  }

  const keys = isJsonObject(properties) ? Object.keys(properties) : [];

  return keys.length > 0 ? keys.join(", ") : undefined;
};

const combinatorNote = (
  combinators: readonly RootCombinator[],
  branchesOf: (key: RootCombinator) => JsonValue[]
): string => {
  if (!combinators.includes("anyOf") && !combinators.includes("oneOf")) {
    return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).";
  }

  const key = combinators.includes("oneOf") ? "oneOf" : "anyOf";

  const rule =
    key === "oneOf"
      ? "Provide parameters for exactly one of"
      : "Provide parameters for at least one of";

  const groups = [
    ...new Set(branchesOf(key).flatMap((branch) => branchGroup(branch) ?? [])),
  ];

  if (groups.length === 0) {
    return `Input constraint: ${rule} the documented parameter groups (flattened from a JSON Schema ${key}).`;
  }

  return `Input constraint: ${rule}: ${groups.map((group) => `(${group})`).join(" or ")}.`;
};

export const flattenRootCombinators = (schema: JsonObject) => {
  const combinators = ROOT_COMBINATORS.filter((key) => key in schema);

  if (combinators.length === 0) {
    return { schema };
  }

  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema;

  const branchesOf = (key: RootCombinator): JsonValue[] => {
    const branches = schema[key];

    return isJsonArray(branches)
      ? branches.map((branch) => resolveLocalRef(branch, schema))
      : [];
  };

  const properties: JsonObject = {};
  const required: string[] = [];

  const addProperties = (source: JsonValue): void => {
    if (!isJsonObject(source) || !isJsonObject(source["properties"])) {
      return;
    }

    for (const [key, value] of Object.entries(source["properties"])) {
      if (!(key in properties)) {
        properties[key] = value;
      }
    }
  };

  const addRequired = (source: JsonValue): void => {
    if (!isJsonObject(source) || !isJsonArray(source["required"])) {
      return;
    }

    for (const key of source["required"]) {
      if (typeof key === "string" && !required.includes(key)) {
        required.push(key);
      }
    }
  };

  addProperties(schema);

  for (const key of combinators) {
    for (const branch of branchesOf(key)) {
      addProperties(branch);
    }
  }

  addRequired(schema);

  for (const branch of branchesOf("allOf")) {
    addRequired(branch);
  }

  const { required: _required, ...withoutRequired } = rest;

  const flat: JsonObject = {
    ...withoutRequired,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };

  return { schema: flat, note: combinatorNote(combinators, branchesOf) };
};

export const createToolServer = (
  name: string,
  tools: readonly McpToolDef[]
): McpSdkServerConfigWithInstance => {
  const server = new McpServer(
    { name, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => {
      const { schema, note } = flattenRootCombinators(tool.inputSchema);

      return {
        name: tool.name,
        description: [note, tool.description]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n"),
        inputSchema: { ...schema, type: "object" as const },
      };
    }),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);

    if (tool === undefined) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const toolCallId = request.params._meta?.[TOOL_USE_ID_META];

    if (typeof toolCallId !== "string") {
      throw new TypeError(
        `${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"]; cannot pair the result with its tool call`
      );
    }

    return { ...(await tool.handler(toolCallId)) };
  });

  return { type: "sdk", name, instance: server };
};
