import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { SideSessionController } from "../session.js";

describe("side conversation AgentSession routing", () => {
  let controller: SideSessionController | undefined;
  let harness: AgentSessionHarness | undefined;

  afterEach(async () => {
    await controller?.dispose();
    harness?.cleanup();
    controller = undefined;
    harness = undefined;
  });

  it("keeps a real child session multi-turn and rejects overlapping prompts", async () => {
    harness = await createAgentSessionHarness();
    harness.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
    ]);
    controller = new SideSessionController(harness.session);

    expect([
      controller.submit("first question"),
      controller.submit("too early"),
    ]).toStrictEqual([true, false]);
    await vi.waitFor(() => {
      expect(controller?.state.isRunning).toBeFalsy();
    });

    expect([
      controller.latestAssistantText(),
      controller.submit("second question"),
    ]).toStrictEqual(["first answer", true]);
    await vi.waitFor(() => {
      expect(controller?.state.isRunning).toBeFalsy();
    });

    expect({
      latest: controller.latestAssistantText(),
      users: controller.state.transcript
        .filter((item) => item.kind === "user")
        .map((item) => item.text),
    }).toStrictEqual({
      latest: "second answer",
      users: ["first question", "second question"],
    });
  });
});
