import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { toGeneratedToolName } from "../bridge.js";
import mcp from "../index.js";
import { MANAGER_TOOL_NAMES } from "../manager.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

describe("MCP tools in a real AgentSession", () => {
  setupMcpTest();

  it("registers during startup, connects in-loop, and replaces a live tool schema", async () => {
    const harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            pi.appendEntry("mcp-server-loaded", { serverName: "mcp-manager" });
          });
        },
        mcp,
      ],
    });
    const name = toGeneratedToolName("remote", "search");
    try {
      expect(harness.session.getActiveToolNames()).toEqual(
        expect.arrayContaining(MANAGER_TOOL_NAMES),
      );
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("mcp_set", {
            name: "remote",
            scope: "global",
            config: fixtureServer(),
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxToolCall("mcp_connect", { name: "remote" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxToolCall(name, { query: "first" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await harness.prompt("Connect and search.");
      expect(harness.messages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolName: name,
            isError: false,
            content: [{ type: "text", text: "result: first" }],
          }),
        ]),
      );
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("mcp_set", {
            name: "remote",
            scope: "global",
            config: fixtureServer("changed"),
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxToolCall(name, { query: "before reconnect" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxToolCall("mcp_connect", { name: "remote", reconnect: true }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxToolCall(name, { term: "second" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await harness.prompt("Reconnect with the updated configuration and search.");
      expect(harness.session.getToolDefinition(name)?.parameters).toMatchObject({
        required: ["term"],
      });
      expect(harness.messages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolName: name,
            isError: false,
            content: [{ type: "text", text: "result: before reconnect" }],
          }),
          expect.objectContaining({
            role: "toolResult",
            toolName: name,
            isError: false,
            content: [{ type: "text", text: "changed: second" }],
          }),
        ]),
      );
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });
});
