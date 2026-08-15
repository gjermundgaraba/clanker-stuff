import { describe, expect, it } from "vitest";

import {
  getActiveProvider,
  providerDisplayName,
  SUPPORTED_PROVIDERS,
} from "../providers.js";

describe("providers", () => {
  it("recognizes exactly the supported providers", () => {
    expect(
      SUPPORTED_PROVIDERS.map((provider) => getActiveProvider({ provider }))
    ).toStrictEqual(SUPPORTED_PROVIDERS);
    expect(getActiveProvider({ provider: "openrouter" })).toBeUndefined();
    expect(getActiveProvider(null)).toBeUndefined();
  });

  it("provides display names", () => {
    expect(SUPPORTED_PROVIDERS.map(providerDisplayName)).toStrictEqual([
      "Claude",
      "Codex",
      "Copilot",
      "MiniMax",
      "MiniMax CN",
      "Kimi",
      "Grok",
      "GLM",
      "OpenCode Go",
    ]);
  });
});
