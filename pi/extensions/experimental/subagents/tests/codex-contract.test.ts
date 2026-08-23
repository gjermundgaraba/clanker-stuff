import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { codexContractFixture as fixture } from "../docs/fixtures/codex-contract.generated.js";
import type { V1Controller } from "../v1/controller.js";
import { registerV1Tools } from "../v1/tools.js";
import type { V2Controller } from "../v2/controller.js";
import { registerV2Tools } from "../v2/tools.js";

describe("pinned Codex collaboration contract", () => {
  it("keeps the Pi V1 and V2 tool families aligned with Codex", async () => {
    const v1 = createExtensionHost((pi) => {
      registerV1Tools(pi, {} as V1Controller, () => {});
    });
    const v2 = createExtensionHost((pi) => {
      registerV2Tools(pi, {} as V2Controller, "/root", () => {});
    });
    await Promise.all([v1.ready, v2.ready]);

    expect([...v1.getRegisteredTools().keys()].toSorted()).toStrictEqual(
      fixture.v1.tools
    );
    expect([...v2.getRegisteredTools().keys()].toSorted()).toStrictEqual(
      fixture.v2.tools
    );
  });

  it("keeps the stock V2 spawn surface and output aligned with Codex", async () => {
    const controller = {
      spawn: () =>
        Promise.resolve({
          nickname: "Atlas",
          task_name: "/root/worker",
        }),
    } as unknown as V2Controller;
    const host = createExtensionHost((pi) => {
      registerV2Tools(pi, controller, "/root", () => {});
    });
    await host.ready;
    const spawn = host.getRegisteredTools().get("spawn_agent")?.definition;
    const parameters = spawn?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(Object.keys(parameters?.properties ?? {}).toSorted()).toStrictEqual(
      fixture.v2.stockSpawnProperties
    );
    const output = await host.runTool("spawn_agent", {
      message: "work",
      task_name: "worker",
    });
    const text = output.content.find((item) => item.type === "text")?.text;
    const parsed: unknown = JSON.parse(text ?? "null");
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new TypeError("Expected spawn_agent to return a JSON object");
    }
    expect(Object.keys(parsed).toSorted()).toStrictEqual(
      fixture.v2.stockSpawnOutputProperties
    );
  });
});
