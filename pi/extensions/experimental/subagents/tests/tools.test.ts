import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { SubagentsConfig } from "../config.js";
import { MAX_DURABLE_TEXT } from "../protocol.js";
import { registerTools } from "../tools.js";
import type { ToolController } from "../tools.js";

const spawned = {
  model: "provider/child",
  task_name: "/root/worker",
  thinkingLevel: "high" as const,
};

const controller = (overrides: Partial<ToolController> = {}): ToolController => ({
  followUp: () => Promise.resolve(),
  interrupt: () => Promise.resolve({ previous_status: "not_found" }),
  list: () => [],
  sendMessage: () => Promise.resolve(),
  spawn: () => Promise.resolve(spawned),
  wait: () => Promise.resolve({ message: "Wait completed.", timed_out: false }),
  ...overrides,
});

const PropertiesSchema = Type.Object({ properties: Type.Record(Type.String(), Type.Unknown()) });

const host = async (tools: ToolController, config: SubagentsConfig = DEFAULT_CONFIG) => {
  const extension = createExtensionHost((pi) => {
    registerTools(pi, tools, "/root", config);
  });

  await extension.ready;

  return extension;
};

const spawnProperties = (extension: Awaited<ReturnType<typeof host>>) => {
  const parameters = extension.getRegisteredTools().get("spawn_agent")?.definition.parameters;

  if (!Value.Check(PropertiesSchema, parameters)) {
    throw new Error("Expected spawn_agent object parameters");
  }

  return parameters.properties;
};

describe("collaboration tools", () => {
  it("matches Codex argument names and result shapes", async () => {
    const spawn = vi.fn<ToolController["spawn"]>(() => Promise.resolve(spawned));

    const extension = await host(
      controller({
        list: () => [
          { agent_name: "/root", agent_status: "running" },
          { agent_name: "/root/worker", agent_status: { completed: "done" } },
          { agent_name: "/root/old", agent_status: "interrupted" },
        ],
        spawn,
      }),
    );

    expect(Object.keys(spawnProperties(extension)).toSorted()).toStrictEqual([
      "fork_turns",
      "message",
      "model",
      "reasoning_effort",
      "task_name",
    ]);

    for (const { definition } of extension.getRegisteredTools().values()) {
      expect(definition.exposure).toBe("model-only");
      expect(definition.renderCall).toBeTypeOf("function");
    }

    await expect(
      extension.runTool("spawn_agent", {
        message: "work",
        reasoning_effort: "high",
        task_name: "worker",
      }),
    ).resolves.toMatchObject({
      content: [{ text: '{"task_name":"/root/worker"}', type: "text" }],
      details: spawned,
    });
    expect(spawn.mock.calls[0]?.[1]).toStrictEqual({
      agentType: undefined,
      forkTurns: "all",
      message: "work",
      model: undefined,
      taskName: "worker",
      thinking: "high",
      tools: extension.getActiveTools(),
    });

    await expect(
      extension.runTool("send_message", { message: "context", target: "worker" }),
    ).resolves.toStrictEqual({
      content: [{ text: "", type: "text" }],
      details: {},
    });
    // Sessions and the tree keep task and message text, so it shares the final-answer limit.
    await expect(
      extension.runTool("send_message", {
        message: "x".repeat(MAX_DURABLE_TEXT + 1),
        target: "worker",
      }),
    ).rejects.toThrow(/Validation failed for tool "send_message":\n {2}- message:/u);
    await expect(
      extension.runTool("spawn_agent", {
        message: "x".repeat(MAX_DURABLE_TEXT + 1),
        task_name: "large",
      }),
    ).rejects.toThrow(/Validation failed for tool "spawn_agent":\n {2}- message:/u);
    // Every node is listed, not only those with a loaded runtime.
    await expect(extension.runTool("list_agents", {})).resolves.toMatchObject({
      details: {
        agents: [
          { agent_name: "/root" },
          { agent_name: "/root/worker" },
          { agent_name: "/root/old" },
        ],
      },
    });
  });

  it("offers agent_type only when roles are configured", async () => {
    const spawn = vi.fn<ToolController["spawn"]>(() => Promise.resolve(spawned));

    const extension = await host(controller({ spawn }), {
      ...DEFAULT_CONFIG,
      roles: { reviewer: { description: "Reviews the requested implementation." } },
    });

    expect(JSON.stringify(spawnProperties(extension).agent_type)).toContain(
      "Reviews the requested implementation.",
    );
    await extension.runTool("spawn_agent", {
      agent_type: "reviewer",
      message: "Review",
      task_name: "worker",
    });
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ agentType: "reviewer" });
    expect(spawnProperties(await host(controller()))).not.toHaveProperty("agent_type");
  });

  it.each([
    [undefined, "all"],
    ["ALL", "all"],
    [" none ", "none"],
    ["3", 3],
    ["18446744073709551616", Number.MAX_SAFE_INTEGER],
  ] as const)("accepts fork_turns %j", async (value, expected) => {
    const spawn = vi.fn<ToolController["spawn"]>(() => Promise.resolve(spawned));
    const extension = await host(controller({ spawn }));

    await extension.runTool("spawn_agent", {
      ...(value === undefined ? {} : { fork_turns: value }),
      message: "work",
      task_name: "worker",
    });

    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ forkTurns: expected });
  });

  it.each(["0", "003", "+3", "0x10", "-1", ""])("rejects fork_turns %j", async (forkTurns) => {
    const extension = await host(controller());

    await expect(
      extension.runTool("spawn_agent", {
        fork_turns: forkTurns,
        message: "work",
        task_name: "worker",
      }),
    ).rejects.toThrow("fork_turns must be `none`, `all`, or a positive integer string");
  });
});
