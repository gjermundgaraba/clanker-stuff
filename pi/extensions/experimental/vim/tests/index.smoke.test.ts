import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("vim extension", () => {
  it("loads Vim and the shared editor through Pi's real extension loader", async () => {
    const directory = path.resolve(import.meta.dirname, "..");

    const harness = await createExtensionSmokeHarness({
      extensions: [directory],
    });

    onTestFinished(() => {
      harness.cleanup();
    });
    expect(harness.extensionsResult.errors).toStrictEqual([]);
    expect(
      harness.extensionsResult.extensions.map((extension) => extension.path)
    ).toContain(
      path.join(harness.projectDir, ".pi", "extensions", "vim", "index.ts")
    );
  });
});
