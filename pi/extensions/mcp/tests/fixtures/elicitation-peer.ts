import { createInterface } from "node:readline";

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

createInterface({ input: process.stdin }).on("line", (line) => {
  // SAFETY: This test-only peer consumes the SDK client's JSON-RPC messages.
  const message = JSON.parse(line) as {
    id: string | number;
    method?: string;
    params?: { name?: string; inputResponses?: { form?: unknown } };
    result?: unknown;
    error?: unknown;
  };
  if (message.method === "server/discover") {
    if (modern)
      result(message.id, {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      });
    else
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
  } else if (message.method === "initialize") {
    result(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo });
  } else if (message.method === "notifications/initialized" && roots) {
    send({ jsonrpc: "2.0", id: "startup-roots", method: "roots/list" });
  } else if (message.id === "startup-roots") {
    startupRoots.resolve(message.error ?? message.result);
  } else if (message.method === "tools/list") {
    result(message.id, {
      tools: [{ name: "interact", inputSchema: { type: "object", properties: {} } }],
    });
  } else if (message.method === "tools/call") {
    if (message.params?.name === "startup-roots") {
      void startupRoots.promise.then((response) => complete(message.id, response));
      return;
    }
    if (message.params?.name === "ping") {
      complete(message.id, "pong");
      return;
    }
    toolId = message.id;
    if (message.params?.inputResponses) complete(message.id, message.params.inputResponses.form);
    else if (modern)
      result(message.id, {
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
  } else if (message.id === "form") complete(toolId, message.error ?? message.result);
});
