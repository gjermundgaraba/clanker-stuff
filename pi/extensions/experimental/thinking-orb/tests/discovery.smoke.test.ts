import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";
import type { ExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

const ORB_ROOT = path.resolve(import.meta.dirname, "..");

describe("thinking-orb discovery", () => {
  let harness: ExtensionSmokeHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("direct-loads the extension package", async () => {
    harness = await createExtensionSmokeHarness({
      extensions: [ORB_ROOT],
    });

    expect(harness.extensionsResult.errors).toStrictEqual([]);
    const orb = harness.extensionsResult.extensions.find(({ resolvedPath }) =>
      resolvedPath.endsWith(path.join("thinking-orb", "index.ts"))
    );
    expect(orb?.commands.has("orb-start")).toBeTruthy();
    expect(orb?.commands.has("orb-setup")).toBeTruthy();
  });
});
