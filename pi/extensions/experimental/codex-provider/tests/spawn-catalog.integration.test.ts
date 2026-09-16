import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import subagents from "../../subagents/index.js";
import codexProvider from "../index.js";
import { createRealCodexSession } from "./agent-session.js";
import { responseEvents, createToolsModel, sse, wireRecord, wireRecords } from "./fixtures.js";
import type { WireRecord } from "./fixtures.js";

describe("spawn catalog provider payload", () => {
  it.each([
    ["v1", "direct"],
    ["v1", "code_mode_only"],
    ["v2", "direct"],
    ["v2", "code_mode_only"],
  ] as const)(
    "refreshes %s guidance through %s and resolves the advertised worker",
    async (protocol, mode) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "spawn-catalog-"));
      const agentDir = path.join(rootDir, "config");
      const cwd = path.join(rootDir, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      await writeFile(
        path.join(agentDir, "subagents.json"),
        JSON.stringify({ version: 1, protocols: { "*": protocol } }),
      );
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          packages: [
            path.resolve(import.meta.dirname, "../../subagents"),
            path.resolve(import.meta.dirname, ".."),
          ],
        }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      const parent = createToolsModel("gpt-5.6-sol", true);
      const workerId = "gpt-5.6-synthetic-worker";
      let description = "Fast and affordable synthetic worker.";
      const requests: WireRecord[] = [];
      const errors: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.includes("/codex/models")) {
          const base = {
            supported_in_api: true,
            support_verbosity: true,
            supports_parallel_tool_calls: true,
            visibility: "list",
            default_reasoning_level: "medium",
            supported_reasoning_levels: ["low", "medium"],
            tool_mode: mode,
          };
          return Response.json({
            models: [
              {
                ...base,
                slug: parent.id,
                display_name: "Parent",
                description: "Capable synthetic parent.",
                priority: 1,
                multi_agent_version: "v2",
              },
              {
                ...base,
                slug: workerId,
                display_name: "Worker",
                description,
                priority: 2,
                multi_agent_version: "v1",
              },
            ],
          });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const decoded =
          request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
        requests.push(wireRecord(JSON.parse(new TextDecoder().decode(decoded))));
        return sse(responseEvents(`response-${requests.length}`, "Finished synthetic task."));
      });
      let session: AgentSession | undefined;
      try {
        session = await createRealCodexSession({
          extensionFactories: [subagents, (pi) => codexProvider(pi, mode)],
          rootDir,
          model: parent,
          sessionManager: SessionManager.inMemory(cwd),
          onExtensionError: (error) => errors.push(error.error),
        });
        const context = session.extensionRunner.createContext();
        await context.modelRegistry.refresh({ force: true, allowNetwork: true });
        expect(context.modelRegistry.getError()).toBeUndefined();
        await session.prompt("Describe your tools.");
        expect(JSON.stringify(requests.at(-1))).toContain(description);
        if (protocol === "v1" && mode === "code_mode_only") {
          expect(JSON.stringify(requests.at(-1)?.instructions)).toContain(
            "pi_subagents__spawn_agent",
          );
        } else {
          const namespace = wireRecords(requests.at(-1)?.tools ?? []).find(
            (tool) => tool.name === "pi_subagents",
          );
          expect(
            wireRecords(namespace?.tools).find((tool) => tool.name === "spawn_agent")?.description,
          ).toContain(description);
        }
        description = "Updated affordable synthetic worker.";
        await context.modelRegistry.refresh({ force: true, allowNetwork: true });
        await session.prompt("Describe your current tools.");
        const refreshed = JSON.stringify(requests.at(-1));
        expect(refreshed).toContain(description);
        expect(refreshed).not.toContain("Fast and affordable synthetic worker.");
        const spawn = session.getToolDefinition("spawn_agent");
        if (spawn === undefined) throw new Error("Missing spawn definition");
        const args =
          protocol === "v2"
            ? {
                task_name: "worker",
                fork_turns: "none",
                model: workerId,
                reasoning_effort: "medium",
                message: "Return a short result.",
              }
            : { model: workerId, reasoning_effort: "medium", message: "Return a short result." };
        await expect(
          spawn.execute("invalid", { ...args, model: "invented" }, undefined, undefined, context),
        ).rejects.toThrow(`Available models: ${parent.id}, ${workerId}`);
        const count = requests.length;
        await spawn.execute("valid", args, undefined, undefined, context);
        await vi.waitFor(() => expect(requests.length).toBeGreaterThan(count), { timeout: 10_000 });
        expect(requests.at(-1)?.model).toBe(workerId);
        // A V1 worker is eligible, but does not gain nested collaboration tools.
        expect(
          wireRecords(requests.at(-1)?.tools ?? []).some((tool) => tool.name === "pi_subagents"),
        ).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        if (session?.hasExtensionHandlers("session_shutdown")) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
        session?.dispose();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
