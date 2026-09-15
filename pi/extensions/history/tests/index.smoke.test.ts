import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createExtensionSmokeHarness } from "../../../tests/harness/extension-smoke.js";

describe("history package discovery", () => {
  it("loads the renamed package through Pi's extension loader", async () => {
    const directory = path.resolve(import.meta.dirname, "..");
    const harness = await createExtensionSmokeHarness({ extensions: [directory] });
    onTestFinished(() => harness.cleanup());

    expect(harness.extensionsResult.errors).toEqual([]);
    expect(harness.extensionsResult.extensions.map((extension) => extension.path)).toContain(
      path.join(harness.projectDir, ".pi", "extensions", "history", "index.ts"),
    );
    expect(
      harness.session.extensionRunner?.getRegisteredCommands().map((command) => command.name),
    ).toContain("history-import");
  });
});
