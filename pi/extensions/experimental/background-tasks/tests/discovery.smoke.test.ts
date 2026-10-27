import path from "node:path";

import { describe, it, expect } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("background-tasks discovery", () => {
  it("loads the package and registers its four tools and command", async () => {
    const h = await createExtensionSmokeHarness({
      packages: [path.resolve(import.meta.dirname, "..")],
    });

    try {
      expect(h.extensionsResult.errors).toStrictEqual([]);

      const extension = h.extensionsResult.extensions.find((e) =>
        e.resolvedPath.includes("background-tasks")
      );

      expect(extension?.commands.has("tasks")).toBe(true);
      expect([...extension!.tools.keys()]).toStrictEqual([
        "task_start",
        "task_list",
        "task_inspect",
        "task_stop",
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
