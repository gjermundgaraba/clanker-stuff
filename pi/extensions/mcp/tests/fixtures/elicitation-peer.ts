import { createInterface } from "node:readline";

import { Type } from "typebox";
import { Value } from "typebox/value";

// A raw JSON peer lets the tests observe wire keys without the server SDK's own
// Zod-record projection hiding the client's serialization behavior.
const modern = process.argv[2] === "modern";

const sampling = process.argv[3] === "sampling";

const roots = process.argv[3] === "roots";

const startupRoots = Promise.withResolvers<unknown>();

const serverInfo = { name: "elicitation-peer", version: "1.0.0" };

const params = {
  mode: "form",
  message: "Provide values",
  requestedSchema: {
    type: "object",
    properties: Object.fromEntries(
      ["__proto__", "constructor", "toString", "ordinary"].map((key) => [
        key,
        { type: "string", minLength: 1 },
      ]),
    ),
    required: ["__proto__", "constructor", "toString", "ordinary"],
  },
};

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The raw JSON-RPC peer preserves arbitrary wire keys to test SDK serialization rather than SDK schema projection.
type PeerPayload = Record<string, unknown>;

const send = (message: PeerPayload) => process.stdout.write(`${JSON.stringify(message)}\n`);

const result = (id: string | number, value: PeerPayload) => {
  const payload = { ...value };

  if (modern) payload.resultType ??= "complete";
  send({ jsonrpc: "2.0", id, result: payload });
};

const complete = (id: string | number, answers: unknown) =>
  result(id, { content: [{ type: "text", text: JSON.stringify(answers) }] });

let toolId: string | number;

const MessageSchema = Type.Object({
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  method: Type.Optional(Type.String()),
  params: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      inputResponses: Type.Optional(Type.Object({ form: Type.Optional(Type.Unknown()) })),
    }),
  ),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Unknown()),
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const message: unknown = JSON.parse(line);

  if (!Value.Check(MessageSchema, message)) throw new Error("Invalid peer message");
  const id = message.id;

  if (id === undefined) {
    if (message.method === "notifications/initialized" && roots)
      send({ jsonrpc: "2.0", id: "startup-roots", method: "roots/list" });

    return;
  }

  if (message.method === "server/discover") {
    if (modern)
      result(id, {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      });
    else
      send({
        jsonrpc: "2.0",
        id: id,
        error: { code: -32601, message: "Method not found" },
      });
  } else if (message.method === "initialize") {
    result(id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo });
  } else if (id === "startup-roots") {
    startupRoots.resolve(message.error ?? message.result);
  } else if (message.method === "tools/list") {
    result(id, {
      tools: [{ name: "interact", inputSchema: { type: "object", properties: {} } }],
    });
  } else if (message.method === "tools/call") {
    if (message.params?.name === "startup-roots") {
      void startupRoots.promise.then((response) => complete(id, response));

      return;
    }

    if (message.params?.name === "ping") {
      complete(id, "pong");

      return;
    }

    toolId = id;

    if (message.params?.inputResponses) complete(id, message.params.inputResponses.form);
    else if (modern)
      result(id, {
        resultType: "input_required",
        inputRequests: { form: { method: "elicitation/create", params } },
        requestState: "form",
      });
    else if (roots) send({ jsonrpc: "2.0", id: "form", method: "roots/list" });
    else if (sampling)
      send({
        jsonrpc: "2.0",
        id: "form",
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: "Count to ten" } }],
          maxTokens: 8,
        },
      });
    else send({ jsonrpc: "2.0", id: "form", method: "elicitation/create", params });
  } else if (id === "form") complete(toolId, message.error ?? message.result);
});
