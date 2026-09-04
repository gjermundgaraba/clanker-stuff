import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { codexContractFixture } from "../../subagents/docs/fixtures/codex-contract.generated.js";
import type { CollaborationContractRequest } from "../collaboration.js";
import {
  COLLABORATION_CONTRACT_REQUEST,
  PI_SUBAGENTS_NAMESPACE,
  requestCollaborationContract,
  rewriteCollaborationTools,
} from "../collaboration.js";
import { createToolsModel, wireArray, wireRecord, wireRecords } from "./fixtures.js";
import type { WireValue } from "./fixtures.js";

const V1_NAMES = codexContractFixture.v1.tools;
const V2_NAMES = codexContractFixture.v2.tools;
const StringSchema = Type.String();
const tools = (names: readonly string[]) =>
  names.map((name) => ({
    description: name,
    name,
    parameters: { additionalProperties: false, properties: {}, type: "object" },
    strict: null,
    type: "function",
  }));
const namespaceMemberNames = (namespace: WireValue): string[] => {
  const members = wireRecord(namespace).tools;
  if (!Array.isArray(members)) {
    return [];
  }
  return members.flatMap((member) => {
    const name = wireRecord(member).name;
    return Value.Check(StringSchema, name) ? [name] : [];
  });
};

const harness = (
  protocol?: "off" | "v1" | "v2",
  nestedTools: readonly ToolDefinition[] = [],
  inheritedServiceTier?: WireValue,
) => {
  const sessionId = "collaboration-session";
  let requestedServiceTier: "priority" | null | undefined;
  let requestedUltra: boolean | undefined;
  const pi = {
    events: {
      emit(channel: string, request: CollaborationContractRequest) {
        requestedServiceTier = request.rootServiceTier;
        requestedUltra = request.ultra;
        if (channel === COLLABORATION_CONTRACT_REQUEST && protocol !== undefined) {
          request.provide({
            inheritedServiceTier,
            nestedTools: nestedTools.map((definition) => ({ definition })),
            protocol,
            sessionId,
            version: 1,
          });
        }
      },
    },
  };
  const ctx = createExtensionHost(() => {}, {
    model: createToolsModel("gpt-5.6-sol"),
    sessionId,
  }).createContext();
  return {
    ctx,
    pi,
    requestedServiceTier: () => requestedServiceTier,
    requestedUltra: () => requestedUltra,
  };
};

describe("Codex collaboration wire projection", () => {
  it("groups the complete V2 family for standard and Lite requests", () => {
    const { ctx, pi } = harness("v2");
    const incomingNames = V2_NAMES.toReversed();
    const standard = wireRecord(
      rewriteCollaborationTools(
        { tools: [{ ...tools(["exec_command"])[0] }, ...tools(incomingNames)] },
        pi,
        ctx,
      ),
    );
    const lite = wireRecord(
      rewriteCollaborationTools(
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
        ctx,
      ),
    );
    const standardTools = wireRecords(standard.tools);
    const liteInput = wireRecords(lite.input);
    const liteTools = wireRecords(liteInput[0]?.tools);

    for (const namespace of [standardTools[1], liteTools[0]]) {
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
        ]),
      );
      expect(namespaceMemberNames(namespace)).toStrictEqual([...V2_NAMES].toSorted());
    }
    expect(standardTools[1]).toStrictEqual(liteTools[0]);
    expect(PI_SUBAGENTS_NAMESPACE).not.toBe(codexContractFixture.v2.namespace);
    const wire = JSON.stringify({ lite, standard });
    expect(wire).not.toContain(`"name":${JSON.stringify(codexContractFixture.v2.namespace)}`);
    expect(wire).not.toContain('"encrypted":true');
  });

  it("uses the Pi namespace for V1 and fails closed for stale complete families", () => {
    const active = harness("v1");
    const rewritten = wireRecord(
      rewriteCollaborationTools({ tools: tools(V1_NAMES.toReversed()) }, active.pi, active.ctx),
    );
    const [namespace] = wireArray(rewritten.tools);
    expect(namespace).toMatchObject({
      name: "pi_subagents",
      type: "namespace",
    });
    expect(namespaceMemberNames(namespace)).toStrictEqual(V1_NAMES);
    expect(PI_SUBAGENTS_NAMESPACE).not.toBe(codexContractFixture.v1.namespace);

    const missing = harness();
    expect(() =>
      rewriteCollaborationTools({ tools: tools(V2_NAMES) }, missing.pi, missing.ctx),
    ).toThrow("without a matching session contract");
    expect(
      rewriteCollaborationTools({ tools: tools(["spawn_agent"]) }, missing.pi, missing.ctx),
    ).toMatchObject({
      tools: [expect.objectContaining({ name: "spawn_agent" })],
    });
  });

  it("keeps reads inert and exchanges explicit Ultra and live service-tier state", () => {
    const active = harness("v2", [], null);

    expect(requestCollaborationContract(active.pi, active.ctx)?.protocol).toBe("v2");
    expect(active.requestedUltra()).toBeUndefined();
    expect(active.requestedServiceTier()).toBeUndefined();
    expect(requestCollaborationContract(active.pi, active.ctx, true)?.protocol).toBe("v2");
    expect(active.requestedUltra()).toBeTruthy();
    expect(
      requestCollaborationContract(active.pi, active.ctx, undefined, "priority")
        ?.inheritedServiceTier,
    ).toBeNull();
    expect(active.requestedServiceTier()).toBe("priority");
  });

  it("rejects malformed inherited state", () => {
    const malformed = harness("v2", [], "default");

    expect(requestCollaborationContract(malformed.pi, malformed.ctx)).toBeUndefined();
  });
});
