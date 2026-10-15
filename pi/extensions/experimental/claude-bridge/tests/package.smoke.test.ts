import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("claude-bridge package", () => {
  it("loads and registers the claude-bridge provider with pi-ai's Anthropic models", async () => {
    const h = await createExtensionSmokeHarness({ packages: [resolve(import.meta.dirname, "..")] });

    try {
      expect(h.extensionsResult.errors).toEqual([]);

      const models = h.session.modelRuntime.getModels("claude-bridge");
      const ids = models.map((model) => model.id);

      expect(ids).toContain("claude-opus-5-5");
      // Dated snapshot aliases stay out of the picker.
      expect(ids.some((id) => /-20\d{6}$/.test(id))).toBe(false);
      // Measured 1M models are registered at the window the bridge requests.
      expect(models.find((model) => model.id === "claude-opus-5-5")?.contextWindow).toBe(1_000_000);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.cleanup();
    }
  });
});
