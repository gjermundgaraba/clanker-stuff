import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExtensionSmokeHarness } from "../../../tests/harness/extension-smoke.js";
import type { ExtensionSmokeHarness } from "../../../tests/harness/extension-smoke.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FOOTER_ROOT = path.join(REPO_ROOT, "footer");
const USAGE_ROOT = path.join(REPO_ROOT, "usage");

describe("cooperative footer discovery", () => {
  let harness: ExtensionSmokeHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("direct-loads the footer host and usage contributor together", async () => {
    harness = await createExtensionSmokeHarness({
      extensions: [FOOTER_ROOT, USAGE_ROOT],
    });

    expect(harness.extensionsResult.errors).toStrictEqual([]);
    const footer = harness.extensionsResult.extensions.find(
      ({ resolvedPath }) =>
        resolvedPath.endsWith(path.join("footer", "index.ts"))
    );
    const usage = harness.extensionsResult.extensions.find(({ resolvedPath }) =>
      resolvedPath.endsWith(path.join("usage", "index.ts"))
    );
    expect(footer?.commands.has("footer")).toBeTruthy();
    expect(usage?.commands.has("usage")).toBeTruthy();
  });
});
