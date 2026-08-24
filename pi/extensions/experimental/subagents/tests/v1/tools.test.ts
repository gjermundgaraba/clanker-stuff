import { Value } from "typebox/value";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { registerV1Tools } from "../../v1/tools.js";
import type { V1ToolController } from "../../v1/tools.js";

const controller = (overrides: Partial<V1ToolController> = {}): V1ToolController => ({
  close: () => Promise.resolve({ previous_status: "not_found" }),
  resume: () => Promise.resolve({ status: "not_found" }),
  sendInput: () => Promise.resolve({ submission_id: "submission" }),
  spawn: () => Promise.resolve({ agent_id: "agent-id", nickname: "Atlas" }),
  wait: () => Promise.resolve({ status: {}, timed_out: false }),
  ...overrides,
});
const PropertiesSchema = Type.Object(
  {
    properties: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: true },
);
const properties = <T>(schema: T) => {
  if (!Value.Check(PropertiesSchema, schema)) {
    throw new Error("Expected object schema properties");
  }
  return schema.properties;
};

describe("V1 model contract", () => {
  it("exposes Codex-compatible schemas and JSON results", async () => {
    const tools = controller({
      close: () => Promise.resolve({ previous_status: { completed: "done" } }),
      resume: () => Promise.resolve({ status: "interrupted" }),
      sendInput: () => Promise.resolve({ submission_id: "submission" }),
      spawn: () => Promise.resolve({ agent_id: "agent-id", nickname: "Atlas" }),
      wait: () =>
        Promise.resolve({
          status: { "agent-id": { completed: "done" } },
          timed_out: false,
        }),
    });
    const host = createExtensionHost((pi) => {
      registerV1Tools(pi, tools, () => {});
    });
    await host.ready;

    const spawn = host.getRegisteredTools().get("spawn_agent")?.definition;
    if (!spawn) {
      throw new Error("Expected spawn_agent");
    }
    const schemaProperties = properties(spawn.parameters);
    expect({
      description: spawn.description,
      reasoning: JSON.stringify(schemaProperties.reasoning_effort),
      schemaAcceptsAgentType: Value.Check(spawn.parameters, {
        agent_type: "reviewer",
        message: "work",
      }),
      schemaAcceptsMessage: Value.Check(spawn.parameters, { message: "work" }),
      schemaNames: Object.keys(schemaProperties).toSorted(),
    }).toStrictEqual({
      description: expect.stringContaining(
        "Delegate non-blocking work with a clear, disjoint scope.",
      ),
      reasoning: expect.stringContaining("Reasoning effort override"),
      schemaAcceptsAgentType: false,
      schemaAcceptsMessage: true,
      schemaNames: ["fork_context", "items", "message", "model", "reasoning_effort"],
    });
    await expect(host.runTool("spawn_agent", { message: "work" })).resolves.toMatchObject({
      content: [{ text: '{"agent_id":"agent-id","nickname":"Atlas"}', type: "text" }],
      details: { agent_id: "agent-id", nickname: "Atlas" },
    });
    await expect(
      host.runTool("wait_agent", {
        targets: ["agent-id"],
        timeout_ms: 30_000,
      }),
    ).resolves.toMatchObject({
      details: {
        status: { "agent-id": { completed: "done" } },
        timed_out: false,
      },
    });
  });

  it("advertises numeric wait timeouts and leaves integer decoding to runtime", async () => {
    const host = createExtensionHost((pi) => {
      registerV1Tools(pi, controller(), () => {});
    });
    await host.ready;
    const wait = host.getRegisteredTools().get("wait_agent")?.definition;
    if (wait === undefined) {
      throw new Error("Expected wait_agent");
    }

    expect({
      fraction: Value.Check(wait.parameters, {
        targets: ["agent"],
        timeout_ms: 10_000.5,
      }),
      integer: Value.Check(wait.parameters, {
        targets: ["agent"],
        timeout_ms: 10_000,
      }),
    }).toStrictEqual({ fraction: true, integer: true });
  });

  it("advertises provider-compatible object roots and leaves input choice validation to runtime", async () => {
    const host = createExtensionHost((pi) => {
      registerV1Tools(pi, controller(), () => {});
    });
    await host.ready;

    for (const name of ["spawn_agent", "send_input"]) {
      const parameters = host.getRegisteredTools().get(name)?.definition.parameters;
      expect(parameters).toMatchObject({
        additionalProperties: false,
        type: "object",
      });
      expect(parameters).not.toHaveProperty("anyOf");
      expect(parameters).not.toHaveProperty("oneOf");
    }

    const spawn = host.getRegisteredTools().get("spawn_agent")?.definition;
    const send = host.getRegisteredTools().get("send_input")?.definition;
    if (spawn === undefined || send === undefined) {
      throw new Error("Expected V1 input tools");
    }
    expect({
      sendBoth: Value.Check(send.parameters, {
        items: [{ text: "item", type: "text" }],
        message: "message",
        target: "agent",
      }),
      sendNeither: Value.Check(send.parameters, { target: "agent" }),
      spawnBoth: Value.Check(spawn.parameters, {
        items: [{ text: "item", type: "text" }],
        message: "message",
      }),
      spawnNeither: Value.Check(spawn.parameters, {}),
    }).toStrictEqual({
      sendBoth: true,
      sendNeither: true,
      spawnBoth: true,
      spawnNeither: true,
    });
  });

  it("advertises only configured roles and includes their descriptions", async () => {
    const host = createExtensionHost((pi) => {
      registerV1Tools(pi, controller(), () => {}, {
        ...structuredClone(DEFAULT_CONFIG),
        roles: {
          reviewer: {
            description: "Reviews changes for correctness.",
          },
        },
      });
    });
    await host.ready;
    const spawn = host.getRegisteredTools().get("spawn_agent")?.definition;
    if (!spawn) {
      throw new Error("Expected spawn_agent");
    }
    const schemaProperties = properties(spawn.parameters);

    expect(Object.keys(schemaProperties)).toContain("agent_type");
    expect(JSON.stringify(schemaProperties.agent_type)).toContain(
      "reviewer: Reviews changes for correctness.",
    );
  });

  it("hides model overrides from the strict spawn schema", async () => {
    const host = createExtensionHost((pi) => {
      registerV1Tools(pi, controller(), () => {}, {
        ...structuredClone(DEFAULT_CONFIG),
        expose_spawn_agent_model_overrides: false,
      });
    });
    await host.ready;
    const definition = host.getRegisteredTools().get("spawn_agent")?.definition;
    if (!definition) {
      throw new Error("Expected spawn_agent");
    }
    const schemaProperties = properties(definition.parameters);

    expect(Object.keys(schemaProperties).toSorted()).toStrictEqual([
      "fork_context",
      "items",
      "message",
    ]);
    expect(
      Value.Check(definition.parameters, {
        message: "work",
        model: "provider/model",
      }),
    ).toBeFalsy();
  });

  it("preserves configured agent_type while hiding only model overrides", async () => {
    const spawn = vi.fn<V1ToolController["spawn"]>(async () => ({
      agent_id: "agent-id",
      nickname: "Atlas",
    }));
    const tools = controller({
      spawn,
    });
    const host = createExtensionHost((pi) => {
      registerV1Tools(pi, tools, () => {}, {
        ...structuredClone(DEFAULT_CONFIG),
        expose_spawn_agent_model_overrides: false,
        roles: { reviewer: { description: "Review changes." } },
      });
    });
    await host.ready;
    const definition = host.getRegisteredTools().get("spawn_agent")?.definition;
    if (!definition) {
      throw new Error("Expected spawn_agent");
    }
    const schemaProperties = properties(definition.parameters);

    expect(Object.keys(schemaProperties).toSorted()).toStrictEqual([
      "agent_type",
      "fork_context",
      "items",
      "message",
    ]);
    await host.runTool("spawn_agent", {
      agent_type: "reviewer",
      message: "work",
    });
    expect(spawn).toHaveBeenCalledWith(
      {
        agentType: "reviewer",
        forkContext: false,
        items: undefined,
        message: "work",
        model: undefined,
        thinking: undefined,
      },
      expect.anything(),
      undefined,
    );
  });
});
