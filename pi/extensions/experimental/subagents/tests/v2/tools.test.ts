import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../../config.js";
import type { V2Controller } from "../../v2/controller.js";
import { registerV2Tools } from "../../v2/tools.js";

describe("V2 model contract", () => {
  it("matches Codex argument names, result shapes, and live-list semantics", async () => {
    const spawnCalls: unknown[][] = [];
    const controller = {
      followUp: () => Promise.resolve({}),
      interrupt: () => Promise.resolve({ previous_status: "running" }),
      list: () => [
        { path: "/root", resident: true, status: "running" },
        {
          lastAnswer: "done",
          path: "/root/worker",
          resident: true,
          status: "completed",
        },
        {
          path: "/root/unloaded",
          resident: false,
          status: "interrupted",
        },
      ],
      sendMessage: () => Promise.resolve({}),
      spawn: (...args: unknown[]) => {
        spawnCalls.push(args);
        return Promise.resolve({
          nickname: "Atlas",
          task_name: "/root/worker",
        });
      },
      wait: () =>
        Promise.resolve({ message: "Wait completed.", timed_out: false }),
    } as unknown as V2Controller;
    const host = createExtensionHost((pi) => {
      registerV2Tools(pi, controller, "/root", () => {});
    });
    await host.ready;

    const spawn = host.getRegisteredTools().get("spawn_agent")?.definition;
    if (!spawn) {
      throw new Error("Expected spawn_agent");
    }
    const parameters = spawn.parameters as typeof spawn.parameters & {
      properties?: Record<string, unknown>;
    };
    expect({
      description: spawn.description,
      forkTurns: JSON.stringify(parameters.properties?.fork_turns),
      hasThinking: "thinking" in (parameters.properties ?? {}),
      names: Object.keys(parameters.properties ?? {}).toSorted(),
      reasoning: JSON.stringify(parameters.properties?.reasoning_effort),
      schemaAcceptsReasoning: Value.Check(spawn.parameters, {
        message: "work",
        reasoning_effort: "high",
        task_name: "worker",
      }),
    }).toStrictEqual({
      description: expect.not.stringContaining("same tools"),
      forkTurns: expect.stringContaining("positive integer string"),
      hasThinking: false,
      names: [
        "fork_turns",
        "message",
        "model",
        "reasoning_effort",
        "task_name",
      ],
      reasoning: expect.stringContaining("Reasoning effort override"),
      schemaAcceptsReasoning: true,
    });
    await expect(
      host.runTool("spawn_agent", {
        message: "work",
        reasoning_effort: "high",
        task_name: "worker",
      })
    ).resolves.toMatchObject({
      content: [{ text: '{"task_name":"/root/worker"}', type: "text" }],
      details: {
        nickname: "Atlas",
        task_name: "/root/worker",
      },
    });
    expect(spawnCalls[0]?.[1]).toMatchObject({ thinking: "high" });

    const [sendResult, listResult] = await Promise.all([
      host.runTool("send_message", {
        message: "context",
        target: "worker",
      }),
      host.runTool("list_agents", {}),
    ]);
    expect({ listResult, sendResult }).toMatchObject({
      listResult: {
        details: {
          agents: [
            { agent_name: "/root", agent_status: "running" },
            {
              agent_name: "/root/worker",
              agent_status: { completed: "done" },
            },
          ],
        },
      },
      sendResult: {
        content: [{ text: "", type: "text" }],
        details: {},
      },
    });
  });

  it("accepts below-minimum wait timeouts for runtime clamping", async () => {
    const host = createExtensionHost((pi) => {
      registerV2Tools(pi, {} as unknown as V2Controller, "/root", () => {});
    });
    await host.ready;
    const wait = host.getRegisteredTools().get("wait_agent")?.definition;
    if (!wait) {
      throw new Error("Expected wait_agent");
    }

    expect({
      fraction: Value.Check(wait.parameters, { timeout_ms: 10_000.5 }),
      negative: Value.Check(wait.parameters, { timeout_ms: -1 }),
    }).toStrictEqual({ fraction: true, negative: true });
  });

  it.each([
    ["ALL", "all"],
    ["", "all"],
    [" 3 ", 3],
    ["+3", 3],
    ["0003", 3],
    ["18446744073709551615", Number.MAX_SAFE_INTEGER],
  ] as const)(
    "normalizes Codex-compatible fork_turns %j",
    async (value, expected) => {
      const spawn = vi.fn<(...args: unknown[]) => Promise<unknown>>(
        (..._args) =>
          Promise.resolve({ nickname: "Atlas", task_name: "/root/worker" })
      );
      const host = createExtensionHost((pi) => {
        registerV2Tools(
          pi,
          { spawn } as unknown as V2Controller,
          "/root",
          () => {}
        );
      });
      await host.ready;

      await host.runTool("spawn_agent", {
        fork_turns: value,
        message: "work",
        task_name: "worker",
      });

      expect(spawn.mock.calls[0]?.[1]).toMatchObject({ forkTurns: expected });
    }
  );

  it.each(["000", "18446744073709551616", "0x10", "1_0", "-1"])(
    "rejects invalid fork_turns %j",
    async (forkTurns) => {
      const host = createExtensionHost((pi) => {
        registerV2Tools(pi, {} as unknown as V2Controller, "/root", () => {});
      });
      await host.ready;

      await expect(
        host.runTool("spawn_agent", {
          fork_turns: forkTurns,
          message: "work",
          task_name: "worker",
        })
      ).rejects.toThrow(
        "fork_turns must be `none`, `all`, or a positive integer string"
      );
    }
  );

  it("projects role-enabled and model-overrides-hidden spawn profiles", async () => {
    const spawn = vi.fn<
      (...args: unknown[]) => Promise<{
        nickname: string;
        task_name: string;
      }>
    >((..._args) =>
      Promise.resolve({ nickname: "Atlas", task_name: "/root/worker" })
    );
    const controller = {
      spawn,
    } as unknown as V2Controller;
    const host = createExtensionHost((pi) => {
      registerV2Tools(pi, controller, "/root", () => {}, {
        ...DEFAULT_CONFIG,
        expose_spawn_agent_model_overrides: false,
        roles: {
          reviewer: {
            description: "Reviews the requested implementation.",
          },
        },
      });
    });
    await host.ready;
    const definition = host.getRegisteredTools().get("spawn_agent")?.definition;
    const parameters = definition?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(Object.keys(parameters?.properties ?? {}).toSorted()).toStrictEqual([
      "agent_type",
      "fork_turns",
      "message",
      "task_name",
    ]);
    expect(JSON.stringify(parameters?.properties?.agent_type)).toContain(
      "Reviews the requested implementation."
    );

    await host.runTool("spawn_agent", {
      agent_type: "reviewer",
      message: "Review",
      task_name: "worker",
    });
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({
      agentType: "reviewer",
      model: undefined,
      thinking: undefined,
    });
  });
});
