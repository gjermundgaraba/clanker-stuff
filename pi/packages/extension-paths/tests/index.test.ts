import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getExtensionStoragePaths } from "../index.js";

describe(getExtensionStoragePaths, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the standard config and data paths", () => {
    const agentDir = path.resolve("/tmp/test-pi-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    expect(getExtensionStoragePaths("example-extension")).toStrictEqual({
      configFile: path.join(agentDir, "example-extension.json"),
      dataDir: path.join(agentDir, "data", "example-extension"),
    });
  });

  it("rejects IDs that could escape their storage namespace", () => {
    expect(() => getExtensionStoragePaths("../example")).toThrow("invalid extension ID");
  });
});
