import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vite-plus/test";

import subagentsExtension from "../../subagents/index.js";
import codexProviderExtension from "../index.js";
import { createRealCodexSession } from "./agent-session.js";
import { responseEvents, SPIKE_MODEL, sse, wireRecord, wireRecords } from "./fixtures.js";
import type { WireRecord } from "./fixtures.js";

const CODEX_PROVIDER_ROOT = path.resolve(import.meta.dirname, "..");
const SUBAGENTS_ROOT = path.resolve(import.meta.dirname, "../../subagents");
const COLLABORATION_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
];
const StringValueSchema = Type.String();

const requestJson = (body: RequestInit["body"], headers: Headers): WireRecord => {
  if (Value.Check(StringValueSchema, body)) {
    return wireRecord(JSON.parse(body));
  }
  if (!(body instanceof Uint8Array)) {
    throw new Error("Unexpected request body");
  }
  const bytes = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(body) : body;
  return wireRecord(JSON.parse(new TextDecoder().decode(bytes)));
};

describe("Codex Ultra with the companion collaboration runtime", () => {
  it("restores before the first call and uses subagents V2 with wire Max", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-ultra-coload-"));
    const cwd = path.join(rootDir, "project");
    const agentDir = path.join(rootDir, "agent-config");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
    await writeFile(
      path.join(agentDir, "subagents.json"),
      `${JSON.stringify({ protocols: { "*": "v2" }, version: 1 })}\n`,
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: [SUBAGENTS_ROOT, CODEX_PROVIDER_ROOT] })}\n`,
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry("codex-ultra-state", { enabled: true });
    const refreshStarted = Promise.withResolvers<null>();
    const releaseRefresh = Promise.withResolvers<null>();
    const requests: WireRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.includes("/codex/models")) {
          refreshStarted.resolve(null);
          await releaseRefresh.promise;
          return Response.json({
            models: [
              {
                context_window: SPIKE_MODEL.contextWindow,
                default_reasoning_level: "max",
                display_name: SPIKE_MODEL.name,
                multi_agent_version: "v2",
                priority: 1,
                slug: SPIKE_MODEL.id,
                support_verbosity: true,
                supported_in_api: true,
                supported_reasoning_levels: [{ effort: "max" }, { effort: "ultra" }],
                supports_parallel_tool_calls: true,
                visibility: "list",
              },
            ],
          });
        }
        requests.push(requestJson(init?.body, new Headers(init?.headers)));
        return sse(responseEvents("restored", "restored result"));
      }),
    );
    let session: AgentSession | undefined;

    try {
      let bound = false;
      const model = Object.assign(
        { ...SPIKE_MODEL, thinkingLevelMap: { high: "high", max: "max" } },
        { multiAgentVersion: "v2" as const },
      );
      const creating = createRealCodexSession({
        extensionFactories: [subagentsExtension, codexProviderExtension],
        model,
        rootDir,
        sessionManager,
      }).then((created) => {
        bound = true;
        return created;
      });
      await refreshStarted.promise;
      expect(bound).toBeFalsy();

      releaseRefresh.resolve(null);
      session = await creating;
      expect(session.thinkingLevel).toBe("max");
      session.setThinkingLevel("high");
      await vi.waitFor(() => expect(session?.thinkingLevel).toBe("max"));
      expect(
        session.getActiveToolNames().filter((name) => COLLABORATION_TOOLS.includes(name)),
      ).toStrictEqual(COLLABORATION_TOOLS);

      const list = session.getToolDefinition("list_agents");
      if (list === undefined) {
        throw new Error("Subagents V2 list_agents was not registered");
      }
      await expect(
        list.execute("list", {}, undefined, undefined, session.extensionRunner.createContext()),
      ).resolves.toMatchObject({
        details: {
          agents: expect.arrayContaining([expect.objectContaining({ agent_name: "/root" })]),
        },
      });

      await session.prompt("Confirm restored Ultra");
      const request = requests.at(-1);
      if (request === undefined) {
        throw new Error("The provider request was not captured");
      }
      const namespace = wireRecords(request.tools).find(
        (tool) => tool.type === "namespace" && tool.name === "pi_subagents",
      );
      expect(wireRecord(request.reasoning)).toMatchObject({ effort: "max" });
      expect(wireRecords(namespace?.tools).map(({ name }) => name)).toStrictEqual(
        [...COLLABORATION_TOOLS].toSorted(),
      );
      expect(request.instructions).toEqual(
        expect.stringContaining("Proactive multi-agent delegation is active."),
      );

      const spawn = session.getToolDefinition("spawn_agent");
      if (spawn === undefined) {
        throw new Error("Subagents V2 spawn_agent was not registered");
      }
      await expect(
        spawn.execute(
          "spawn",
          { fork_turns: "none", message: "Return inherited Ultra", task_name: "inherited" },
          undefined,
          undefined,
          session.extensionRunner.createContext(),
        ),
      ).resolves.toMatchObject({
        content: [{ text: JSON.stringify({ task_name: "/root/inherited" }) }],
      });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const childRequest = requests.at(-1);
      expect(wireRecord(childRequest?.reasoning)).toMatchObject({ effort: "max" });
      expect(childRequest?.instructions).toEqual(
        expect.stringContaining("Proactive multi-agent delegation is active."),
      );

      await spawn.execute(
        "spawn-native-max",
        {
          fork_turns: "none",
          message: "Use native Max only",
          reasoning_effort: "max",
          task_name: "native_max",
        },
        undefined,
        undefined,
        session.extensionRunner.createContext(),
      );
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      const nativeMaxRequest = requests.at(-1);
      expect(wireRecord(nativeMaxRequest?.reasoning)).toMatchObject({ effort: "max" });
      expect(nativeMaxRequest?.instructions).not.toEqual(
        expect.stringContaining("Proactive multi-agent delegation is active."),
      );

      await session.prompt("/ultra");
      expect(
        session.getActiveToolNames().filter((name) => COLLABORATION_TOOLS.includes(name)),
      ).toStrictEqual(COLLABORATION_TOOLS);
      await expect(
        list.execute(
          "list-after-disable",
          {},
          undefined,
          undefined,
          session.extensionRunner.createContext(),
        ),
      ).resolves.toMatchObject({
        details: {
          agents: expect.arrayContaining([expect.objectContaining({ agent_name: "/root" })]),
        },
      });

      const requestCount = requests.length;
      await spawn.execute(
        "spawn-after-disable",
        {
          fork_turns: "none",
          message: "Confirm native Max without proactive policy",
          task_name: "after_disable",
        },
        undefined,
        undefined,
        session.extensionRunner.createContext(),
      );
      await vi.waitFor(() => expect(requests).toHaveLength(requestCount + 1));
      expect(requests.at(-1)?.instructions).not.toEqual(
        expect.stringContaining("Proactive multi-agent delegation is active."),
      );
    } finally {
      releaseRefresh.resolve(null);
      if (session?.hasExtensionHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ reason: "quit", type: "session_shutdown" });
      }
      session?.dispose();
      await rm(rootDir, { force: true, recursive: true });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("propagates root Fast changes to V2 child providers", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-fast-coload-"));
    const cwd = path.join(rootDir, "project");
    const agentDir = path.join(rootDir, "agent-config");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
    await writeFile(
      path.join(agentDir, "subagents.json"),
      `${JSON.stringify({ protocols: { "*": "v2" }, version: 1 })}\n`,
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: [SUBAGENTS_ROOT, CODEX_PROVIDER_ROOT] })}\n`,
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const requests: WireRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(requestJson(init?.body, new Headers(init?.headers)));
        return sse(responseEvents(`fast-child-${requests.length}`, "done"));
      }),
    );
    let session: AgentSession | undefined;

    try {
      const model = Object.assign(
        {
          ...SPIKE_MODEL,
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
        },
        { multiAgentVersion: "v2" as const },
      );
      session = await createRealCodexSession({
        extensionFactories: [subagentsExtension, codexProviderExtension],
        model,
        rootDir,
        sessionManager: SessionManager.inMemory(cwd),
      });
      const activeSession = session;
      const spawn = activeSession.getToolDefinition("spawn_agent");
      if (spawn === undefined) {
        throw new Error("Subagents V2 tools were not registered");
      }
      const runChild = async (message: string, taskName: string) => {
        const expected = requests.length + 1;
        await spawn.execute(
          `spawn-${message}`,
          { fork_turns: "none", message, task_name: taskName },
          undefined,
          undefined,
          activeSession.extensionRunner.createContext(),
        );
        await vi.waitFor(
          () => {
            expect(requests).toHaveLength(expected);
          },
          { timeout: 10_000 },
        );
      };

      await runChild("standard", "standard");
      expect(requests.at(-1)?.service_tier).toBeUndefined();

      await activeSession.prompt("/fast");
      await runChild("priority", "priority");
      expect(requests.at(-1)?.service_tier).toBe("priority");

      await activeSession.prompt("/fast");
      await runChild("standard-again", "standard_again");
      expect(requests.at(-1)?.service_tier).toBeUndefined();
    } finally {
      if (session?.hasExtensionHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ reason: "quit", type: "session_shutdown" });
      }
      session?.dispose();
      await rm(rootDir, { force: true, recursive: true });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
