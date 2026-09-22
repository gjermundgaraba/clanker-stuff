import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { ENTRY_TYPE, restoreSnapshots } from "../entry.js";
import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("turn-recap package", () => {
  it("discovers the renamed extension and records a run without configuration", async () => {
    const harness = await createExtensionSmokeHarness({
      extensions: [path.resolve(import.meta.dirname, "..")],
    });

    try {
      expect(harness.extensionsResult.errors).toEqual([]);
      harness.setResponses([fauxAssistantMessage("Done")]);
      await harness.prompt("Hello");
      const restored = restoreSnapshots(harness.sessionManager.getBranch());
      expect(restored.current).toMatchObject({ outcome: "completed", recap: { status: "off" } });
      expect(harness.session.extensionRunner.getEntryRenderer(ENTRY_TYPE)).toBeUndefined();
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });
});
