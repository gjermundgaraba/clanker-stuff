import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getExtensionStoragePaths } from "../index.js";

describe(getExtensionStoragePaths, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the standard global and project paths", () => {
    const agentDir = path.resolve("/tmp/test-pi-agent");
    const projectDir = path.resolve("/tmp/test-project");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const paths = getExtensionStoragePaths("example-extension");

    expect(paths).toMatchObject({
      cacheDir: path.join(agentDir, "cache", "example-extension"),
      configFile: path.join(agentDir, "example-extension.json"),
      dataDir: path.join(agentDir, "data", "example-extension"),
    });
    expect(paths.project(projectDir)).toStrictEqual({
      configFile: path.join(projectDir, ".pi", "example-extension.json"),
    });
  });

  it("rejects IDs that could escape their storage namespace", () => {
    expect(() => getExtensionStoragePaths("../example")).toThrow(
      "invalid extension ID"
    );
  });
});
