import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import mcp from "../index.js";
import type { SamplingScopeRequest } from "../sampling-protocol.js";
import { setupMcpTest } from "./helpers.js";

describe("MCP tool usage", () => {
  const t = setupMcpTest();
  it.each(["sampling", "sampling-error"])(
    "returns received usage on the %s result",
    async (scenario) => {
      const fixture = await t.startHttpFixture({ scenario });
      await t.writeConfig({ mcpServers: { sample: { type: "http", url: fixture.url } } });

      const usage = {
        input: 7,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      const model = fauxProvider().getModel();

      const host = t.createExtensionHost(
        (pi) => {
          mcp(pi);
          pi.events.on("clanker-codex:sampling-scope-request", (request) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The actual MCP producer is the sole emitter in this isolated test host.
            const typed = request as SamplingScopeRequest;
            typed.resolve(
              Promise.resolve({
                run: <T>(run: () => T) => run(),
                boundText: (text: string) => text,
                dispose: async () => {},
                status: { limitReached: false, usageComplete: true, usage },
              }),
            );
          });
        },
        { model, hasUI: false },
      );

      await host.emitSessionStart();

      const ctx = host.createToolContext({
        ui: { select: async () => "○ sample" },
        modelRegistry: { complete: vi.fn(async () => fauxAssistantMessage("sample")) },
      });

      await host.runCommand("mcp", "", ctx);
      expect(host.getNotifications().some((note) => note.type === "error")).toBe(false);

      const name = [...host.getRegisteredTools().keys()].find((name) =>
        name.startsWith("mcp_sample_"),
      );

      if (!name) throw new Error("Missing generated MCP tool");
      const result = await host.runTool(name, { maxTokens: 8, rounds: 1 }, { ctx });
      expect(result).toMatchObject({ usage, details: { sampling: [{ complete: true }] } });
      expect(result.isError ?? false).toBe(scenario === "sampling-error");
      await host.emitSessionShutdown();
    },
  );
});
