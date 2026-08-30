import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { COLLABORATION_CONTRACT_REQUEST, registerContractResponder } from "../contract.js";
import { codexContractFixture as fixture } from "../docs/fixtures/codex-contract.generated.js";
import { registerV1Tools } from "../v1/tools.js";
import type { V1ToolController } from "../v1/tools.js";
import { registerV2Tools } from "../v2/tools.js";
import type { V2ToolController } from "../v2/tools.js";

const v1Controller = (): V1ToolController => ({
  close: () => Promise.resolve({ previous_status: "not_found" }),
  resume: () => Promise.resolve({ status: "not_found" }),
  sendInput: () => Promise.resolve({ submission_id: "submission" }),
  spawn: () => Promise.resolve({ agent_id: "agent", nickname: "Atlas" }),
  wait: () => Promise.resolve({ status: {}, timed_out: false }),
});
const v2Controller = (): V2ToolController => ({
  followUp: () => Promise.resolve(),
  interrupt: () => Promise.resolve({ previous_status: "not_found" }),
  list: () => [],
  sendMessage: () => Promise.resolve(),
  spawn: () => Promise.resolve({ nickname: "Atlas", task_name: "/root/worker" }),
  wait: () => Promise.resolve({ message: "Wait completed.", timed_out: false }),
});
const PropertiesSchema = Type.Object(
  {
    properties: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: true },
);
const JsonObjectSchema = Type.Object({}, { additionalProperties: true });

describe("pinned Codex collaboration contract", () => {
  it("distinguishes a read-only contract request from an explicit Ultra update", async () => {
    const updates: (boolean | undefined)[] = [];
    const host = createExtensionHost((pi) => {
      registerContractResponder(
        pi,
        () => ({ nestedTools: [], protocol: "v2", sessionId: "contract-session" }),
        (_ctx, ultra) => updates.push(ultra),
      );
    });
    await host.ready;
    const request = (ultra?: boolean) => {
      const payload = {
        context: host.createContext(),
        provide: () => {},
        sessionId: "contract-session",
      };
      host.events.emit(
        COLLABORATION_CONTRACT_REQUEST,
        ultra === undefined ? payload : { ...payload, ultra },
      );
    };

    request();
    request(false);

    expect(updates).toStrictEqual([undefined, false]);
  });

  it("keeps the Pi V1 and V2 tool families aligned with Codex", async () => {
    const v1 = createExtensionHost((pi) => {
      registerV1Tools(pi, v1Controller(), () => {});
    });
    const v2 = createExtensionHost((pi) => {
      registerV2Tools(pi, v2Controller(), "/root", () => {});
    });
    await Promise.all([v1.ready, v2.ready]);

    expect([...v1.getRegisteredTools().keys()].toSorted()).toStrictEqual(fixture.v1.tools);
    expect([...v2.getRegisteredTools().keys()].toSorted()).toStrictEqual(fixture.v2.tools);
  });

  it("keeps the stock V2 spawn surface and output aligned with Codex", async () => {
    const host = createExtensionHost((pi) => {
      registerV2Tools(pi, v2Controller(), "/root", () => {});
    });
    await host.ready;
    const spawn = host.getRegisteredTools().get("spawn_agent")?.definition;
    if (spawn === undefined || !Value.Check(PropertiesSchema, spawn.parameters)) {
      throw new Error("Expected spawn_agent object schema");
    }

    expect(Object.keys(spawn.parameters.properties).toSorted()).toStrictEqual(
      fixture.v2.stockSpawnProperties,
    );
    const output = await host.runTool("spawn_agent", {
      message: "work",
      task_name: "worker",
    });
    const text = output.content.find((item) => item.type === "text")?.text;
    const parsed = JSON.parse(text ?? "null");
    if (!Value.Check(JsonObjectSchema, parsed)) {
      throw new TypeError("Expected spawn_agent to return a JSON object");
    }
    expect(Object.keys(parsed).toSorted()).toStrictEqual(fixture.v2.stockSpawnOutputProperties);
  });
});
