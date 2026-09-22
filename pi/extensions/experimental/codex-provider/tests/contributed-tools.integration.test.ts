import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ContributedTools,
  collectContributions,
  CONTRIBUTIONS_PUBLISH,
} from "@clanker-stuff/code-mode-tools";
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
import type { ToolInventory } from "@clanker-stuff/code-mode-tools";
import mcp from "../../../mcp/index.js";
import { toGeneratedToolName } from "../../../mcp/bridge.js";
import { fixtureServer, setupMcpTest } from "../../../mcp/tests/helpers.js";
import { toNestedTool } from "../code-mode/tools.js";
import backgroundTasks from "../../background-tasks/index.js";
import { registerCodexTools } from "../tools/register.js";

it("publishes dynamic contributed schemas to the next model request in the same turn", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-contributions-"));

  const session = await createRealCodexSession({
    rootDir,
    model: createToolsModel("gpt-6-astra", true),
    sessionManager: SessionManager.inMemory(rootDir),
    extensionFactories: [
      (pi) => {
        const source = new ContributedTools(pi);
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
        registerCodexTools(pi, undefined, "code_mode_only");
      },
    ],
  });

  const inventories: ReturnType<typeof getCurrentTools>[] = [];
  session.agent.streamFunction = (model, context) => {
    inventories.push(getCurrentTools(context.messages));
    const first = inventories.length === 1;

    const message = {
      ...fauxAssistantMessage("ok"),
      api: model.api,
      model: model.id,
      provider: model.provider,
      ...(first
        ? {
            content: [
              { type: "toolCall" as const, id: "discover-call", name: "discover", arguments: {} },
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
  } finally {
    session.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
});

it.each(["exclude", "allowlist"] as const)(
  "honors %s restrictions for static and dynamically registered nested tools",
  async (restriction) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-restrictions-"));
    const denied = "mcp_fixture_denied";
    const allowed = "mcp_fixture_allowed";
    const execute = vi.fn(async () => ({ content: [], details: undefined }));
    let source: ContributedTools | undefined;
    let proposed: ToolInventory[] = [];

    const session = await createRealCodexSession({
      rootDir,
      model: createToolsModel("gpt-6-astra", true),
      sessionManager: SessionManager.inMemory(rootDir),
      ...(restriction === "exclude"
        ? { excludeTools: ["task_start", "exec_command", denied] }
        : { tools: ["exec", "wait", "task_list", allowed] }),
      extensionFactories: [
        (pi) => {
          registerCodexTools(pi, undefined, "code_mode_only");
          backgroundTasks(pi);
          source = new ContributedTools(pi);
          pi.events.on(CONTRIBUTIONS_PUBLISH, () => {
            proposed = collectContributions(pi);
          });
        },
      ],
    });

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
      const description = session.getToolDefinition("exec")?.description;
      expect(description).not.toContain("### `task_start`");
      expect(description).not.toContain("### `exec_command`");
      expect(description).not.toContain(denied);
      expect(description).toContain("### `task_list`");
      expect(description).toContain(allowed);
      expect(session.getActiveToolNames()).not.toContain(allowed);
      expect(session.getToolDefinition(denied)).toBeUndefined();
      expect(source.snapshot().tools.map(({ definition }) => definition.name)).toEqual([allowed]);

      const rejected = proposed
        .flatMap(({ tools }) => tools)
        .find(({ definition }) => definition.name === denied);

      if (!rejected) throw new Error("Missing proposed tool");
      expect(() =>
        rejected.definition.execute(
          "denied",
          {},
          undefined,
          undefined,
          session.extensionRunner.createContext(),
        ),
      ).toThrow("no longer available");
      const accepted = source.snapshot().tools[0];

      if (!accepted) throw new Error("Missing admitted tool");
      await accepted.definition.execute(
        "allowed",
        {},
        undefined,
        undefined,
        session.extensionRunner.createContext(),
      );
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

describe("restricted MCP discovery", () => {
  const t = setupMcpTest();
  it("keeps excluded generated tools out of exec while admitting permitted nested tools", async () => {
    await t.writeConfig({ mcpServers: { denied: fixtureServer(), allowed: fixtureServer() } });
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-restrictions-"));
    const denied = toGeneratedToolName("denied", "search");
    const allowed = toGeneratedToolName("allowed", "search");
    let inventories = (): ToolInventory[] => [];

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
          registerCodexTools(pi, undefined, "code_mode_only");
          inventories = () => collectContributions(pi);
        },
      ],
    });

    try {
      const connect = session.getToolDefinition("mcp_connect");

      if (!connect) throw new Error("Missing MCP manager");
      const ctx = session.extensionRunner.createContext();

      for (const name of ["denied", "allowed"])
        await connect.execute(name, { name }, undefined, undefined, ctx);
      const description = session.getToolDefinition("exec")?.description;
      expect(description).not.toContain(denied);
      expect(description).toContain(allowed);
      expect(session.getToolDefinition(denied)).toBeUndefined();
      expect(session.getActiveToolNames()).not.toContain(allowed);
      const tools = inventories().flatMap(({ tools }) => tools);
      expect(tools.some(({ definition }) => definition.name === denied)).toBe(false);
      const tool = tools.find(({ definition }) => definition.name === allowed);

      if (!tool) throw new Error("Missing permitted MCP tool");
      await expect(
        toNestedTool(tool).invoke(
          { query: "permitted" },
          { cellId: "test", extensionContext: ctx },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "result: permitted" }],
      });
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
