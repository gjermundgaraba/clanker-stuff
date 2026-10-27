import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";
import { ENTRY_TYPE } from "../entry.js";

describe("turn-recap package", () => {
  it("discovers the renamed extension and records a run without configuration", async () => {
    const harness = await createExtensionSmokeHarness({
      extensions: [path.resolve(import.meta.dirname, "..")],
    });

    try {
      expect(harness.extensionsResult.errors).toStrictEqual([]);
      harness.setResponses([fauxAssistantMessage("Done")]);
      await harness.prompt("Hello");

      const cards = harness.sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE
        );

      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ data: { outcome: "completed" } });
      expect(
        harness.session.extensionRunner.getEntryRenderer(ENTRY_TYPE)
      ).toBeDefined();
    } finally {
      await harness.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      harness.cleanup();
    }
  });
});
