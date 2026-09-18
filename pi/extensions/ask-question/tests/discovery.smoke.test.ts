import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionSmokeHarness } from "../../../tests/harness/extension-smoke.js";

describe("questionnaire discovery", () => {
  it("loads the package entry with only the supported tool names and inbox", async () => {
    const harness = await createExtensionSmokeHarness({
      extensions: [resolve(import.meta.dirname, "..")],
    });

    try {
      expect(harness.extensionsResult.errors).toEqual([]);
      const extension = harness.extensionsResult.extensions[0];
      assert(extension);
      expect([...extension.tools.keys()]).toEqual([
        "request_user_input",
        "request_user_input_async",
      ]);
      expect(extension.commands.has("answers")).toBe(true);
      expect(extension.markdownTransformer).toBeTypeOf("function");
    } finally {
      harness.cleanup();
    }
  });
});
