// In-process MCP server that exposes pi tools to Claude Code.
//
// Pi declares tool parameters as TypeBox objects, which are already JSON Schema, the
// same thing MCP puts on the wire. They are served verbatim instead of through the
// SDK's `createSdkMcpServer`, which accepts only Zod and so forces a lossy JSON
// Schema → Zod → JSON Schema round trip: nested objects collapse to open records and
// `anyOf`/`const` vanish, so Claude saw only the first level of tools like `edit`.
// The one exception is a top-level combinator, flattened below because Claude Code
// drops a tool whose schema has one.
//
// Handlers go on the underlying protocol server, not `McpServer.registerTool` (the
// Zod-only path). That also skips argument validation, which is wanted: pi validates
// and executes tools itself, and a rejection here would only strand the call. This
// rests on the Agent SDK treating the server as an opaque JSON-RPC endpoint; if it
// breaks after an SDK update, check whether the SDK began inspecting the instance.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { acceptedImageType, IMAGE_MARKER } from "./images.js";
import { isJsonArray, isJsonObject } from "./json.js";

// Claude Code stamps every tools/call with the id of the tool_use block it came from.
// That is the only reliable pairing: call order need not match the order the blocks
// were emitted. This is a Claude Code extension to MCP; if it ever stops sending it,
// every call fails loudly rather than pairing results to the wrong call.
const TOOL_USE_ID_META = "claudecode/toolUseId";

export type McpContent = (
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
)[];

export interface McpResult {
  content: McpContent;
  isError?: boolean;
}

export function toolResultToMcpContent(content: ToolResultMessage["content"]): McpContent {
  const blocks: McpContent = [];

  for (const block of content) {
    if (block.type === "text") {
      if (block.text !== "") blocks.push({ type: "text", text: block.text });
    } else {
      const mimeType = acceptedImageType(block);

      blocks.push(
        mimeType === undefined
          ? { type: "text", text: IMAGE_MARKER }
          : { type: "image", data: block.data, mimeType },
      );
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

export interface McpToolDef {
  name: string;
  description: string;
  /** The tool's JSON Schema: pi's TypeBox parameters as plain JSON. */
  inputSchema: JsonObject;
  handler: (toolCallId: string) => Promise<McpResult>;
}

// Claude Code drops an MCP tool outright when its input schema has a top-level
// anyOf/oneOf/allOf. The tool would still be in the served-name map, so a call Claude
// makes anyway runs in pi while Claude Code answers "No such tool available" and
// retries under a fresh id: the tool runs twice, or the retry waits forever. Advertise
// a flat object instead, built the way Claude Code's own normalizer does: root
// properties win over branch ones, root `required` stays, and allOf requirements join
// it. Branch `$ref`s into the root's `$defs`/`definitions` are followed, and the lost
// constraint is restated in the description so Claude's first call is likely to pass
// pi's validation against the full schema.
const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

type RootCombinator = (typeof ROOT_COMBINATORS)[number];

function resolveLocalRef(branch: JsonValue, root: JsonObject): JsonValue {
  if (!isJsonObject(branch) || typeof branch["$ref"] !== "string") return branch;

  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(branch["$ref"]);
  const defs = match?.[1] === undefined ? undefined : root[match[1]];
  const target = isJsonObject(defs) && match?.[2] !== undefined ? defs[match[2]] : undefined;

  return isJsonObject(target) ? target : branch;
}

// A branch is named by its required keys, else by all of its keys.
function branchGroup(branch: JsonValue): string | undefined {
  if (!isJsonObject(branch)) return undefined;

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
}

// Claude Code's wording, so the tool reads the same as one it normalized itself.
function combinatorNote(
  combinators: readonly RootCombinator[],
  branchesOf: (key: RootCombinator) => JsonValue[],
): string {
  if (!combinators.includes("anyOf") && !combinators.includes("oneOf")) {
    return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).";
  }

  const key = combinators.includes("oneOf") ? "oneOf" : "anyOf";

  const rule =
    key === "oneOf"
      ? "Provide parameters for exactly one of"
      : "Provide parameters for at least one of";

  const groups = [...new Set(branchesOf(key).flatMap((branch) => branchGroup(branch) ?? []))];

  if (groups.length === 0) {
    return `Input constraint: ${rule} the documented parameter groups (flattened from a JSON Schema ${key}).`;
  }

  return `Input constraint: ${rule}: ${groups.map((group) => `(${group})`).join(" or ")}.`;
}

export function flattenRootCombinators(schema: JsonObject): {
  schema: JsonObject;
  note?: string;
} {
  const combinators = ROOT_COMBINATORS.filter((key) => key in schema);

  if (combinators.length === 0) return { schema };

  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema;

  const branchesOf = (key: RootCombinator): JsonValue[] => {
    const branches = schema[key];

    return isJsonArray(branches) ? branches.map((branch) => resolveLocalRef(branch, schema)) : [];
  };

  const properties: JsonObject = {};
  const required: string[] = [];

  const addProperties = (source: JsonValue): void => {
    if (!isJsonObject(source) || !isJsonObject(source["properties"])) return;

    for (const [key, value] of Object.entries(source["properties"])) {
      if (!(key in properties)) properties[key] = value;
    }
  };

  const addRequired = (source: JsonValue): void => {
    if (!isJsonObject(source) || !isJsonArray(source["required"])) return;

    for (const key of source["required"]) {
      if (typeof key === "string" && !required.includes(key)) required.push(key);
    }
  };

  addProperties(schema);

  for (const key of combinators) {
    for (const branch of branchesOf(key)) addProperties(branch);
  }

  addRequired(schema);

  for (const branch of branchesOf("allOf")) addRequired(branch);

  const { required: _required, ...withoutRequired } = rest;

  const flat: JsonObject = {
    ...withoutRequired,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };

  return { schema: flat, note: combinatorNote(combinators, branchesOf) };
}

export function createToolServer(
  name: string,
  tools: readonly McpToolDef[],
): McpSdkServerConfigWithInstance {
  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => {
      const { schema, note } = flattenRootCombinators(tool.inputSchema);

      return {
        name: tool.name,
        description: [note, tool.description]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n"),
        // MCP requires an object schema. A union's flattening already is one; anything
        // else is served as an object, the way pi's own Anthropic provider serves it,
        // rather than failing every turn over one tool.
        inputSchema: { ...schema, type: "object" as const },
      };
    }),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);

    if (tool === undefined) throw new Error(`Unknown tool: ${request.params.name}`);

    const toolCallId = request.params._meta?.[TOOL_USE_ID_META];

    if (typeof toolCallId !== "string") {
      throw new Error(
        `${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"]; cannot pair the result with its tool call`,
      );
    }

    // An object literal: MCP's result type is open to extra fields, an interface is not.
    return { ...(await tool.handler(toolCallId)) };
  });

  return { type: "sdk", name, instance: server };
}
