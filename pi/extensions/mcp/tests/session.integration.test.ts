import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { toGeneratedToolName } from "../bridge.js";
import mcp from "../index.js";
import { MANAGER_TOOL_NAMES } from "../manager.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

describe("MCP tools in a real AgentSession", () => {
  const t = setupMcpTest();

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
  it.each(["sampling", "sampling-error"])(
    "attributes automatic sampling usage to %s in session history",
    async (scenario) => {
      const fixture = await t.startHttpFixture({ scenario });
      const dispose = vi.fn(async () => {});
      const usage = {
        input: 7,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const harness = await createAgentSessionHarness({
        extensionFactories: [
          (pi) => {
            pi.on("session_start", () => {
              pi.appendEntry("mcp-server-loaded", { serverName: "mcp-manager" });
            });
            pi.events.on("clanker-codex:sampling-scope-request", (request) => {
              // SAFETY: Only the MCP sampling owner emits this event in the isolated test runtime.
              const typed = request as { resolve: (scope: Promise<unknown>) => void };
              typed.resolve(
                Promise.resolve({
                  run: <T>(run: () => T) => run(),
                  boundText: (text: string) => text,
                  dispose,
                  status: { limitReached: true, usageComplete: true, usage },
                }),
              );
            });
          },
          mcp,
        ],
      });
      const name = toGeneratedToolName("sample", "interact");
      try {
        harness.setResponses([
          fauxAssistantMessage(
            fauxToolCall("mcp_set", {
              name: "sample",
              scope: "global",
              config: { type: "http", url: fixture.url },
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(fauxToolCall("mcp_connect", { name: "sample" }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(fauxToolCall(name, { maxTokens: 8, rounds: 2 }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("one two"),
          fauxAssistantMessage("three four"),
          fauxAssistantMessage("done"),
        ]);
        await harness.prompt("Use the fixture sampling tool.");
        const result = harness
          .messages()
          .find((message) => message.role === "toolResult" && message.toolName === name);
        expect(result).toMatchObject({
          role: "toolResult",
          isError: scenario === "sampling-error",
          usage: { totalTokens: 32, output: 18 },
          details: { sampling: [{ complete: true }, { complete: true }] },
        });
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(fixture.state.operations).toBe(1);
      } finally {
        await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        harness.cleanup();
      }
    },
  );
  it("retains partial sampling accounting after caller cancellation", async () => {
    const fixture = await t.startHttpFixture({ scenario: "sampling" });
    await t.writeConfig({ mcpServers: { sample: { type: "http", url: fixture.url } } });
    const usage = {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const dispose = vi.fn(async () => {});
    const started = Promise.withResolvers<void>();
    const harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            pi.appendEntry("mcp-server-loaded", { serverName: "sample" });
          });
          pi.events.on("clanker-codex:sampling-scope-request", (request) => {
            // SAFETY: The isolated MCP owner is the only emitter of this test event.
            const typed = request as { resolve: (scope: Promise<unknown>) => void };
            typed.resolve(
              Promise.resolve({
                run: <T>(run: () => T) => run(),
                boundText: (text: string) => text,
                dispose,
                status: { limitReached: false, usageComplete: false, usage },
              }),
            );
          });
        },
        mcp,
      ],
    });
    const name = toGeneratedToolName("sample", "interact");
    try {
      harness.setResponses([
        fauxAssistantMessage(fauxToolCall(name, { maxTokens: 8 }), { stopReason: "toolUse" }),
        async (_context, options) => {
          started.resolve();
          await new Promise<void>((_resolve, reject) =>
            options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
              once: true,
            }),
          );
          return fauxAssistantMessage("unreachable");
        },
      ]);
      const prompt = harness.prompt("Sample and wait.");
      await started.promise;
      await harness.session.abort();
      await prompt;
      expect(
        harness
          .messages()
          .find((message) => message.role === "toolResult" && message.toolName === name),
      ).toMatchObject({
        isError: true,
        usage,
        details: { sampling: [{ complete: false, usage }] },
      });
      expect(dispose).toHaveBeenCalledOnce();
      expect(fixture.state.operations).toBe(0);
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });
});
