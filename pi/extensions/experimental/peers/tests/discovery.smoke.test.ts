import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("peers discovery", () => {
  it("loads the package and registers its two tools and command", async () => {
    const h = await createExtensionSmokeHarness({
      packages: [path.resolve(import.meta.dirname, "..")],
    });

    try {
      expect(h.extensionsResult.errors).toStrictEqual([]);

      const extension = h.extensionsResult.extensions.find((e) =>
        e.resolvedPath.includes("peers")
      );

      expect(extension?.commands.has("peers")).toBe(true);
      expect([...(extension?.tools.keys() ?? [])]).toStrictEqual([
        "peer_send",
        "peer_list",
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
