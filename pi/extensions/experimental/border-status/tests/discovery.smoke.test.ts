import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";
import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

it("discovers the border host package and its command", async () => {
  const harness = await createExtensionSmokeHarness({
    extensions: [resolve(import.meta.dirname, "..")],
  });

  try {
    expect(harness.extensionsResult.errors).toEqual([]);
    expect(harness.extensionsResult.extensions[0]!.commands.has("border-status")).toBe(true);
  } finally {
    harness.cleanup();
  }
});
