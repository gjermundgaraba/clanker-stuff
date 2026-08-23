import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { codexContractFixture } from "../../subagents/docs/fixtures/codex-contract.generated.js";
import {
  PI_SUBAGENTS_NAMESPACE,
  rewriteCollaborationTools,
} from "../collaboration.js";

const V1_NAMES = codexContractFixture.v1.tools;
const V2_NAMES = codexContractFixture.v2.tools;
const tools = (names: readonly string[]) =>
  names.map((name) => ({
    description: name,
    name,
    parameters: { additionalProperties: false, properties: {}, type: "object" },
    strict: null,
    type: "function",
  }));
const namespaceMemberNames = (
  namespace: Record<string, unknown> | undefined
): string[] => {
  const members = namespace?.tools;
  if (!Array.isArray(members)) {
    return [];
  }
  return members.flatMap((member) =>
    typeof member === "object" &&
    member !== null &&
    "name" in member &&
    typeof member.name === "string"
      ? [member.name]
      : []
  );
};

const harness = (
  protocol?: "off" | "v1" | "v2",
  nestedTools: readonly ToolDefinition[] = []
) => {
  const sessionId = "collaboration-session";
  const pi = {
    events: {
      emit(channel: string, request: unknown) {
        if (
          channel === "clanker-stuff:subagents:contract:request" &&
          protocol !== undefined &&
          typeof request === "object" &&
          request !== null &&
          "provide" in request &&
          typeof request.provide === "function"
        ) {
          request.provide({
            nestedTools: nestedTools.map((definition) => ({ definition })),
            protocol,
            sessionId,
            version: 1,
          });
        }
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  return { ctx, pi };
};

describe("Codex collaboration wire projection", () => {
  it("groups the complete V2 family for standard and Lite requests", () => {
    const { ctx, pi } = harness("v2");
    const incomingNames = V2_NAMES.toReversed();
    const standard = rewriteCollaborationTools(
      { tools: [{ ...tools(["exec_command"])[0] }, ...tools(incomingNames)] },
      pi,
      ctx
    ) as { tools: Record<string, unknown>[] };
    const lite = rewriteCollaborationTools(
      {
        input: [
          {
            role: "developer",
            tools: tools(incomingNames),
            type: "additional_tools",
          },
        ],
      },
      pi,
      ctx
    ) as { input: { tools: Record<string, unknown>[] }[] };

    for (const namespace of [standard.tools[1], lite.input[0]?.tools[0]]) {
      expect(namespace).toMatchObject({
        name: "pi_subagents",
        type: "namespace",
      });
      expect(namespace?.tools).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "spawn_agent",
            parameters: expect.objectContaining({
              additionalProperties: false,
            }),
            strict: false,
          }),
        ])
      );
      expect(namespaceMemberNames(namespace)).toStrictEqual(
        [...V2_NAMES].toSorted()
      );
    }
    expect(standard.tools[1]).toStrictEqual(lite.input[0]?.tools[0]);
    expect(PI_SUBAGENTS_NAMESPACE).not.toBe(codexContractFixture.v2.namespace);
    const wire = JSON.stringify({ lite, standard });
    expect(wire).not.toContain(
      `"name":${JSON.stringify(codexContractFixture.v2.namespace)}`
    );
    expect(wire).not.toContain('"encrypted":true');
  });

  it("uses the Pi namespace for V1 and fails closed for stale complete families", () => {
    const active = harness("v1");
    const [namespace] = (
      rewriteCollaborationTools(
        { tools: tools(V1_NAMES.toReversed()) },
        active.pi,
        active.ctx
      ) as {
        tools: Record<string, unknown>[];
      }
    ).tools;
    expect(namespace).toMatchObject({
      name: "pi_subagents",
      type: "namespace",
    });
    expect(namespaceMemberNames(namespace)).toStrictEqual(V1_NAMES);
    expect(PI_SUBAGENTS_NAMESPACE).not.toBe(codexContractFixture.v1.namespace);

    const missing = harness();
    expect(() =>
      rewriteCollaborationTools(
        { tools: tools(V2_NAMES) },
        missing.pi,
        missing.ctx
      )
    ).toThrow("without a matching session contract");
    expect(
      rewriteCollaborationTools(
        { tools: tools(["spawn_agent"]) },
        missing.pi,
        missing.ctx
      )
    ).toMatchObject({
      tools: [expect.objectContaining({ name: "spawn_agent" })],
    });
  });
});
