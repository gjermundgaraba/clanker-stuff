import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContentTools } from "@clanker-stuff/code-mode-tools";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRealCodexSession } from "./agent-session.js";
import { createToolsModel } from "./fixtures.js";
import mcp from "../../../mcp/index.js";
import { toGeneratedToolName } from "../../../mcp/bridge.js";
import { fixtureServer, setupMcpTest } from "../../../mcp/tests/helpers.js";
import { toNestedTool } from "../code-mode/tools.js";
import backgroundTasks from "../../background-tasks/index.js";
import { registerFallbackCodexTools } from "./tool-fixtures.js";

type Session = Awaited<ReturnType<typeof createRealCodexSession>>;

const captureRequests = (session: Session, firstTool?: string) => {
  const inventories: ReturnType<typeof getCurrentTools>[] = [];
  session.agent.streamFunction = (model, context) => {
    inventories.push(getCurrentTools(context.messages));
    const first = firstTool !== undefined && inventories.length === 1;

    const message = {
      ...fauxAssistantMessage("ok"),
      api: model.api,
      model: model.id,
      provider: model.provider,
      ...(first
        ? {
            content: [
              { type: "toolCall" as const, id: "discover-call", name: firstTool, arguments: {} },
            ],
            stopReason: "toolUse" as const,
          }
        : {}),
    };

    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });

    return stream;
  };

  return inventories;
};

const dispose = async (session: Session, rootDir: string) => {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  await rm(rootDir, { recursive: true, force: true });
};

it("describes dynamically registered capabilities on the next request in the same turn", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-capabilities-"));

  const session = await createRealCodexSession({
    rootDir,
    model: createToolsModel("gpt-6-astra", true),
    sessionManager: SessionManager.inMemory(rootDir),
    extensionFactories: [
      (pi) => {
        const source = new ContentTools(pi);
        pi.registerTool({
          name: "discover",
          label: "Discover",
          description: "Discover a tool",
          parameters: Type.Object({}),
          execute: async () => {
            source.registerTool({
              name: "discovered",
              label: "Discovered",
              description: "Newly discovered tool",
              parameters: Type.Object({ query: Type.String() }),
              execute: async () => ({ content: [], details: undefined }),
            });
            source.setEnabled(["discovered"]);

            return { content: [], details: undefined };
          },
        });
        registerFallbackCodexTools(pi, { evaluationToolMode: "code_mode_only" });
      },
    ],
  });

  const inventories = captureRequests(session, "discover");

  try {
    await session.prompt("Discover a tool");
    expect(inventories).toHaveLength(2);
    expect(inventories[0]?.find(({ name }) => name === "exec")?.description).not.toContain(
      "Newly discovered",
    );
    expect(inventories[1]?.find(({ name }) => name === "exec")?.description).toContain(
      "Newly discovered",
    );
    expect(inventories[1]?.find(({ name }) => name === "exec")?.description).toContain('"query"');
    expect(inventories[1]?.map(({ name }) => name)).not.toContain("discovered");
    expect(session.getActiveToolNames()).toContain("discovered");
  } finally {
    await dispose(session, rootDir);
  }
});

it.each(["exclude", "allowlist"] as const)(
  "honors %s restrictions for static and dynamically registered capabilities",
  async (restriction) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-restrictions-"));
    const denied = "mcp_fixture_denied";
    const allowed = "mcp_fixture_allowed";
    const execute = vi.fn(async () => ({ content: [], details: undefined }));
    let source: ContentTools | undefined;

    const session = await createRealCodexSession({
      rootDir,
      model: createToolsModel("gpt-6-astra", true),
      sessionManager: SessionManager.inMemory(rootDir),
      ...(restriction === "exclude"
        ? { excludeTools: ["task_start", "exec_command", denied] }
        : { tools: ["exec", "task_list", allowed] }),
      extensionFactories: [
        (pi) => {
          registerFallbackCodexTools(pi, { evaluationToolMode: "code_mode_only" });
          backgroundTasks(pi);
          source = new ContentTools(pi);
        },
      ],
    });

    const inventories = captureRequests(session);

    try {
      if (!source) throw new Error("Missing source");

      for (const name of [denied, allowed])
        source.registerTool({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          execute,
        });
      source.setEnabled();
      await session.prompt("Describe enabled tools");
      const description = inventories[0]?.find(({ name }) => name === "exec")?.description;
      expect(description).not.toContain("### `task_start`");
      expect(description).not.toContain("### `exec_command`");
      expect(description).not.toContain(denied);
      expect(description).toContain("### `task_list`");
      expect(description).toContain(allowed);
      expect(session.getToolDefinition(denied)).toBeUndefined();
      const ctx = session.extensionRunner.createToolContext("test", undefined);
      const blocked = await ctx.executeTool(denied, {});
      expect(blocked.isError).toBe(true);
      const accepted = await ctx.executeTool(allowed, {});
      expect(accepted.isError).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await dispose(session, rootDir);
    }
  },
);

describe("restricted MCP discovery", () => {
  const t = setupMcpTest();
  it("keeps excluded generated capabilities out of exec and executes admitted tools through Pi", async () => {
    await t.writeConfig({ mcpServers: { denied: fixtureServer(), allowed: fixtureServer() } });
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-restrictions-"));
    const denied = toGeneratedToolName("denied", "search");
    const allowed = toGeneratedToolName("allowed", "search");

    const session = await createRealCodexSession({
      rootDir,
      model: createToolsModel("gpt-6-astra", true),
      sessionManager: SessionManager.inMemory(rootDir),
      excludeTools: [denied],
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            pi.appendEntry("mcp-server-loaded", { serverName: "mcp-manager" });
          });
          mcp(pi);
          registerFallbackCodexTools(pi, { evaluationToolMode: "code_mode_only" });
        },
      ],
    });

    const inventories = captureRequests(session);

    try {
      const connect = session.getToolDefinition("mcp_connect");

      if (!connect) throw new Error("Missing MCP manager");
      const ctx = session.extensionRunner.createToolContext("test", undefined);

      for (const name of ["denied", "allowed"])
        await connect.execute(name, { name }, undefined, undefined, ctx);
      await session.prompt("Describe admitted tools");
      const description = inventories[0]?.find(({ name }) => name === "exec")?.description;
      expect(description).not.toContain(denied);
      expect(description).toContain(allowed);
      expect(session.getToolDefinition(denied)).toBeUndefined();
      const tool = session.getToolDefinition(allowed);

      if (!tool) throw new Error("Missing permitted MCP tool");
      await expect(
        toNestedTool(tool).invoke(
          { query: "permitted" },
          { cellId: "test", extensionContext: ctx },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "result: permitted" }] });
    } finally {
      await dispose(session, rootDir);
    }
  });
});
