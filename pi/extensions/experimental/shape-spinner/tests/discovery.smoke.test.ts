import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("shape spinner discovery", () => {
  it("loads the local package with its bundled font metadata", async () => {
    const harness = await createExtensionSmokeHarness({
      packages: [path.resolve(import.meta.dirname, "..")],
    });
    try {
      expect(harness.extensionsResult.errors).toStrictEqual([]);
      const extension = harness.extensionsResult.extensions.find(({ resolvedPath }) =>
        resolvedPath.endsWith(path.join("shape-spinner", "index.ts")),
      );
      expect(extension?.commands.has("shape-spinner")).toBeTruthy();
    } finally {
      harness.cleanup();
    }
  });
});
