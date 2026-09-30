import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";
import { CodeModeHostClient } from "../../code-mode/host-client.js";
import { CodeModeRuntime } from "../../code-mode/tools.js";
import { createRealCodexSession } from "../agent-session.js";

const usage = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("native Code Mode Pi pipeline", () => {
  it.each(["success", "failed", "blocked", "invalid"] as const)(
    "runs nested %s calls through Pi and persists parent-linked accounting",
    async (scenario) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-nested-pipeline-"));
      const client = new CodeModeHostClient("unused");
      const parameters: TSchema = Type.Object({ value: Type.Integer() });
      const prepared = vi.fn((args: unknown) => args);
      const executed = vi.fn();
      const hooks: { type: string; parent?: string }[] = [];
      vi.spyOn(client, "shutdown").mockResolvedValue();
      // Replace only the native transport. The extension context and tool pipeline are real Pi.
      vi.spyOn(client, "execute").mockImplementation(async (_source, ctx, signal, tools) => {
        const probe = tools.find((tool) => tool.definition.name === "probe");

        if (!probe) throw new Error("Missing callable probe");

        try {
          const value = await probe.invoke(
            { value: scenario === "invalid" ? "wrong" : 1 },
            { cellId: "cell", extensionContext: ctx.extensionContext },
            signal ?? new AbortController().signal,
          );

          return {
            cellId: "cell",
            kind: "result",
            contentItems: [{ type: "input_text", text: String(value) }],
          };
        } catch (error) {
          return {
            cellId: "cell",
            kind: "result",
            contentItems: [],
            errorText: error instanceof Error ? error.message : String(error),
          };
        }
      });
      const runtime = new CodeModeRuntime({ createClient: async () => client });

      const session = await createRealCodexSession({
        rootDir,
        sessionManager: SessionManager.inMemory(rootDir),
        extensionFactories: [
          (pi) => {
            pi.registerTool({
              name: "probe",
              label: "Probe",
              description: "Probe",
              parameters,
              prepareArguments: prepared,
              execute: async (_id, args) => {
                executed(args);

                return {
                  content: [{ type: "text", text: "tool output" }],
                  details: undefined,
                  usage,
                  ...(scenario === "failed" ? { isError: true } : {}),
                };
              },
            });
            pi.registerTool(runtime.createExecTool());
            pi.on("session_start", () => pi.setActiveTools(["exec", "probe"]));
            pi.on("session_shutdown", () => runtime.shutdown());
            pi.on("tool_call", (event) => {
              if (event.toolName !== "probe") return;
              hooks.push({
                type: "call",
                ...(event.parentToolCallId ? { parent: event.parentToolCallId } : {}),
              });

              if (scenario === "blocked") return { block: true, reason: "permission denied" };
              event.input.value = 7;
            });
            pi.on("tool_result", (event) => {
              if (event.toolName !== "probe") return;
              hooks.push({
                type: "result",
                ...(event.parentToolCallId ? { parent: event.parentToolCallId } : {}),
              });

              return { content: [{ type: "text", text: "hook output" }] };
            });
          },
        ],
      });

      let request = 0;
      session.agent.streamFunction = (model) => {
        const first = request++ === 0;

        const message = {
          ...fauxAssistantMessage("done"),
          api: model.api,
          provider: model.provider,
          model: model.id,
          ...(first
            ? {
                content: [
                  {
                    type: "toolCall" as const,
                    id: "outer",
                    name: "exec",
                    arguments: { code: "probe" },
                  },
                ],
                stopReason: "toolUse" as const,
              }
            : {}),
        };

        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });

        return stream;
      };

      try {
        await session.prompt("Run a script");
        expect(prepared).toHaveBeenCalledOnce();

        const outer = session.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "outer",
        );

        if (!outer || outer.role !== "toolResult")
          throw new Error("Missing persisted outer result");
        expect(outer.nestedCalls).toMatchObject({
          complete: true,
          calls: [
            { id: "outer/1", name: "probe", status: scenario === "success" ? "ok" : "error" },
          ],
        });
        expect(outer.isError).toBe(scenario !== "success");

        if (scenario === "success" || scenario === "failed") {
          expect(executed).toHaveBeenCalledExactlyOnceWith({ value: 7 });
          expect(hooks).toEqual([
            { type: "call", parent: "outer" },
            { type: "result", parent: "outer" },
          ]);
          expect(outer.usage).toEqual(usage);
          expect(outer.content).toEqual(
            expect.arrayContaining([
              {
                type: "text",
                text: scenario === "success" ? "hook output" : "Script error: hook output",
              },
            ]),
          );
        } else {
          expect(executed).not.toHaveBeenCalled();
          expect(outer.usage).toBeUndefined();
        }
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
