import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("waits discovery", () => {
  it("loads the package and registers its three tools and command", async () => {
    const h = await createExtensionSmokeHarness({
      packages: [path.resolve(import.meta.dirname, "..")],
    });

    try {
      expect(h.extensionsResult.errors).toStrictEqual([]);

      const extension = h.extensionsResult.extensions.find((e) =>
        e.resolvedPath.includes("waits")
      );

      expect(extension?.commands.has("waits")).toBe(true);
      expect([...(extension?.tools.keys() ?? [])]).toStrictEqual([
        "wait_start",
        "wait_list",
        "wait_cancel",
      ]);
    } finally {
      await h.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      h.cleanup();
    }
  });
});
