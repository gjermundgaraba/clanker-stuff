import { describe, expect, it } from "vite-plus/test";

import { getActiveProvider, SUPPORTED_PROVIDERS, usageResult } from "../providers.js";

describe("providers", () => {
  it("recognizes exactly the supported providers", () => {
    expect(SUPPORTED_PROVIDERS.map((provider) => getActiveProvider({ provider }))).toStrictEqual(
      SUPPORTED_PROVIDERS,
    );
    expect(getActiveProvider({ provider: "openrouter" })).toBe("openrouter");
    expect(getActiveProvider({ provider: "unknown" })).toBeUndefined();
    expect(getActiveProvider(null)).toBeUndefined();
  });

  it("requires quota, accounting, or explicit eligibility", () => {
    expect(usageResult({ fetchedAt: 1, provider: "radius", quotaWindows: [] })).toMatchObject({
      ok: false,
    });
    expect(
      usageResult({
        accounting: { available: 0, kind: "credit-balance" },
        fetchedAt: 1,
        provider: "openai-codex",
        quotaWindows: [],
      }),
    ).toMatchObject({ ok: true });
  });
});
