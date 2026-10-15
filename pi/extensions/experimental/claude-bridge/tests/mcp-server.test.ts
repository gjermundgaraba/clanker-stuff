// What the bridge puts on the MCP wire, read back through a real MCP client: tool schemas
// survive verbatim below the top level, and every call pairs with Claude's own
// tool_use id.

import type { JsonObject } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { createToolServer, jsonSchema, toolResultToMcpContent } from "../mcp-server.js";
import type { McpToolDef } from "../mcp-server.js";

const NESTED_TOOL_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    question: { type: "string", description: "Question to ask" },
    options: {
      type: "array",
      description: "Choices to offer",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short label" },
          detail: { type: "string" },
        },
        required: ["label"],
      },
    },
    config: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["single", "multi"] },
        retries: { type: "integer" },
      },
      required: ["mode"],
    },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["question", "options"],
};

async function connect(tools: readonly McpToolDef[]): Promise<Client> {
  const server = createToolServer("custom-tools", tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

const toolDef = (
  name: string,
  inputSchema: JsonObject,
  handler: McpToolDef["handler"] = () => Promise.resolve({ content: [] }),
): McpToolDef => ({ name, description: "d", inputSchema, handler });

async function listOne(inputSchema: JsonObject) {
  const client = await connect([toolDef("union_tool", inputSchema)]);

  const {
    tools: [listed],
  } = await client.listTools();

  if (listed === undefined) throw new Error("tools/list returned no tools");

  return listed;
}

/** Claude Code identifies the call it is making through `_meta` on every tools/call. */
const callTool = (client: Client, name: string, toolUseId: string, args: JsonObject = {}) =>
  client.callTool({ name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } });

describe("jsonSchema", () => {
  // A scalar schema typechecks in pi but cannot go on the wire; advertising it as "no
  // arguments" would surface much later as pi rejecting arguments Claude never sent.
  it("rejects a non-object parameter schema, naming the tool", () => {
    expect(() => jsonSchema("bad_tool", Type.String())).toThrow(
      /^bad_tool: MCP tool parameters must be an object schema/,
    );
    expect(() => jsonSchema("bad_tool", Type.Array(Type.String()))).toThrow(/^bad_tool: /);
  });

  it("copies a TypeBox object schema as plain JSON", () => {
    const schema = jsonSchema("read", Type.Object({ path: Type.String() }));

    expect(schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(Object.getOwnPropertySymbols(schema)).toEqual([]);
  });
});

describe("MCP tool schema advertisement", () => {
  it("serves a nested schema verbatim", async () => {
    const client = await connect([
      { ...toolDef("ask_user_question", NESTED_TOOL_SCHEMA), description: "Ask the user" },
    ]);

    const { tools } = await client.listTools();

    expect(tools).toEqual([
      { name: "ask_user_question", description: "Ask the user", inputSchema: NESTED_TOOL_SCHEMA },
    ]);
  });

  it("leaves the description alone without a top-level combinator", async () => {
    const listed = await listOne({ type: "object", properties: { a: { type: "string" } } });

    expect(listed.description).toBe("d");
  });
});

// Claude Code drops a tool whose input schema has a top-level anyOf/oneOf/allOf, while the
// bridge still maps it as served: a call reached pi and ran there while Claude Code
// answered "No such tool available" and retried. Pi validates against the full schema
// itself, so the bridge only advertises a flat object Claude Code accepts.
describe("MCP tool schema with top-level combinators", () => {
  it("flattens a top-level anyOf, keeping root declarations and requirements", async () => {
    const listed = await listOne({
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["start", "status"] },
        input: { type: "string" },
      },
      anyOf: [
        {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["start"] },
            baseRef: { type: "string" },
          },
        },
        {
          type: "object",
          properties: { operation: { type: "string", enum: ["status"] } },
          required: ["input"],
        },
      ],
    });

    // A branch-only requirement is not universal, and the root declaration wins.
    expect(listed.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["start", "status"] },
        input: { type: "string" },
        baseRef: { type: "string" },
      },
    });
    expect(listed.description).toBe(
      "Input constraint: Provide parameters for at least one of: (operation, baseRef) or (input).\n\nd",
    );
  });

  it("keeps allOf requirements, which apply to every call", async () => {
    const listed = await listOne({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      allOf: [{ type: "object", properties: { b: { type: "number" } }, required: ["b"] }],
    });

    expect(listed.inputSchema).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    });
    expect(listed.description).toBe(
      "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).\n\nd",
    );
  });

  it("follows a oneOf's $defs refs and names each group", async () => {
    const listed = await listOne({
      type: "object",
      $defs: {
        byId: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        byName: {
          type: "object",
          properties: { name: { type: "string" }, scope: { type: "string" } },
          required: ["name"],
        },
      },
      oneOf: [{ $ref: "#/$defs/byId" }, { $ref: "#/$defs/byName" }],
    });

    expect(listed.inputSchema).not.toHaveProperty("oneOf");
    // Each branch's requirement holds only for that branch.
    expect(listed.inputSchema).not.toHaveProperty("required");
    expect(listed.inputSchema.properties).toEqual({
      id: { type: "string" },
      name: { type: "string" },
      scope: { type: "string" },
    });
    expect(listed.description).toBe(
      "Input constraint: Provide parameters for exactly one of: (id) or (name).\n\nd",
    );
  });
});

describe("MCP tool invocation", () => {
  // Two tools, so a handler picked by position rather than by name shows.
  function twoTools(calls: [string, string][]): McpToolDef[] {
    return [
      toolDef("alpha", { type: "object", properties: {} }, (toolCallId) => {
        calls.push(["alpha", toolCallId]);

        return Promise.resolve({ content: [{ type: "text", text: "from alpha" }] });
      }),
      toolDef(
        "beta",
        { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        (toolCallId) => {
          calls.push(["beta", toolCallId]);

          return Promise.resolve({ content: [{ type: "text", text: "from beta" }], isError: true });
        },
      ),
    ];
  }

  it("routes a call to the named tool's handler", async () => {
    const calls: [string, string][] = [];
    const client = await connect(twoTools(calls));

    const result = await callTool(client, "beta", "toolu_b", { x: "hi" });

    expect(calls).toEqual([["beta", "toolu_b"]]);
    expect(result).toEqual({ content: [{ type: "text", text: "from beta" }], isError: true });
  });

  // Inferring the id from call order pairs a result with the wrong call whenever the
  // order diverges, as with parallel tool calls.
  it("hands the handler Claude's tool_use id, not one inferred from call order", async () => {
    const calls: [string, string][] = [];
    const client = await connect(twoTools(calls));

    await callTool(client, "beta", "toolu_second", { x: "hi" });
    await callTool(client, "alpha", "toolu_first");

    expect(calls).toEqual([
      ["beta", "toolu_second"],
      ["alpha", "toolu_first"],
    ]);
  });

  it("fails loudly without a tool_use id rather than mispairing", async () => {
    const calls: [string, string][] = [];
    const client = await connect(twoTools(calls));

    await expect(client.callTool({ name: "alpha", arguments: {} })).rejects.toThrow(/toolUseId/);
    expect(calls).toEqual([]);
  });

  // toolCallId is the bridge's own pairing bookkeeping, not part of CallToolResult.
  it("does not leak internal fields into the tool result", async () => {
    const client = await connect([
      toolDef("alpha", { type: "object", properties: {} }, (toolCallId) =>
        Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false, toolCallId }),
      ),
    ]);

    const result = await callTool(client, "alpha", "toolu_x");

    expect(Object.keys(result).toSorted()).toEqual(["content", "isError"]);
  });

  // A schema rejection here would skip the handler and strand the call: pi validates.
  it("invokes the handler even when the arguments do not match the schema", async () => {
    let called = false;

    const client = await connect([
      toolDef(
        "strict",
        {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
        () => {
          called = true;

          return Promise.resolve({ content: [{ type: "text", text: "ran" }] });
        },
      ),
    ]);

    const result = await callTool(client, "strict", "toolu_y", { count: "not-a-number", extra: 1 });

    expect(called).toBe(true);
    expect(result).toEqual({ content: [{ type: "text", text: "ran" }] });
  });
});

it("converts pi tool content to MCP content, never leaving it empty", () => {
  expect(
    toolResultToMcpContent([
      { type: "text", text: "see" },
      { type: "text", text: "" },
      { type: "image", data: "iVBOR", mimeType: "image/png" },
    ]),
  ).toEqual([
    { type: "text", text: "see" },
    { type: "image", data: "iVBOR", mimeType: "image/png" },
  ]);
  expect(toolResultToMcpContent([{ type: "text", text: "" }])).toEqual([
    { type: "text", text: "" },
  ]);
});
