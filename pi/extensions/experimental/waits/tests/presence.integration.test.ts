import { setTimeout as delay } from "node:timers/promises";

import { PARKED_CHANNEL } from "@clanker-stuff/presence-protocol";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import extension from "../index.js";

describe("waits and presence", () => {
  it("reports each live wait as parked work, and none once it is cancelled", async () => {
    const reports: string[] = [];

    const listen = (pi: ExtensionAPI) => {
      pi.events.on(PARKED_CHANNEL, (data) => {
        reports.push(JSON.stringify(data));
      });
    };

    const h = await createAgentSessionHarness({
      extensionFactories: [extension, listen],
      mode: "rpc",
    });

    try {
      h.setResponses([
        fauxAssistantMessage(
          fauxToolCall("wait_start", {
            label: "the release build",
            condition: "false",
            instruction: "Pick up the build.",
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("Waiting."),
      ]);
      await h.prompt("Wait for the build");

      expect(reports.at(-1)).toContain(
        '"about":"a wait for the release build"'
      );

      const id =
        /"id":"(?<id>w_[0-9a-f]+)"/u.exec(reports.at(-1) ?? "")?.groups?.[
          "id"
        ] ?? "";

      h.setResponses([
        fauxAssistantMessage(fauxToolCall("wait_cancel", { id }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Cancelled."),
      ]);
      await h.prompt("Cancel it");
      await delay(50);

      expect(reports.at(-1)).toBe('{"source":"waits","items":[]}');
    } finally {
      await h.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      h.cleanup();
    }
  });
});
