import assert from "node:assert/strict";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../tests/harness/extension-smoke.js";

describe("questionnaire discovery", () => {
  it("loads the package entry with only the supported tool names and inbox", async () => {
    const harness = await createExtensionSmokeHarness({
      extensions: [path.resolve(import.meta.dirname, "..")],
    });

    try {
      expect(harness.extensionsResult.errors).toStrictEqual([]);
      const [extension] = harness.extensionsResult.extensions;
      assert.ok(extension);
      expect([...extension.tools.keys()]).toStrictEqual([
        "request_user_input",
        "request_user_input_async",
        "revise_user_input",
      ]);
      expect(extension.commands.has("answers")).toBe(true);
      expect(extension.markdownTransformer).toBeTypeOf("function");
    } finally {
      harness.cleanup();
    }
  });
});
