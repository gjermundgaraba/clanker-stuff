import { fauxProvider } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG, parseModelOverride, resolveChildSettings } from "../config.js";
import { spawnModelsDescription, suggestedSpawnModels } from "../model-catalog.js";

const model = (id: string, extra = {}) => ({
  ...fauxProvider({ provider: "test", models: [{ id, reasoning: true }] }).getModel(),
  ...extra,
});

const registry = (models: Model<Api>[], visible = models) => ({
  find: (provider: string, id: string) =>
    models.find((m) => m.provider === provider && m.id === id),
  getAvailable: () => visible,
});

describe("spawn model catalog", () => {
  it("describes native model names and supported efforts without private projections", () => {
    const child = model("small", {
      name: "Small worker",
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: null },
    });

    const models = registry([child]);
    expect(spawnModelsDescription(models)).toBe(
      "Available model overrides (optional; inherited parent model is preferred):\n" +
        "- `test/small`: Small worker. Reasoning efforts: low, medium.",
    );
    expect(parseModelOverride("test/small", models, child)).toBe(child);
  });

  it("caps cross-provider picker suggestions without limiting explicit selections", () => {
    const hidden = model("hidden");
    const visible = Array.from({ length: 7 }, (_, n) => model(`option-${n}`));
    const foreign = model("foreign", { provider: "other" });
    const models = registry([hidden, foreign, ...visible], [foreign, ...visible]);
    expect(suggestedSpawnModels(models)).toEqual([foreign, ...visible].slice(0, 5));
    expect(parseModelOverride("test/option-6", models, visible[0])).toBe(visible[6]);
    expect(parseModelOverride("test/hidden", models, visible[0])).toBe(hidden);

    expect(parseModelOverride("other/foreign", models)).toBe(foreign);
    expect(() => parseModelOverride("test/invented", models)).toThrow(
      "Available models: other/foreign, test/option-0, test/option-1, test/option-2, test/option-3",
    );
    expect(spawnModelsDescription(registry([], []))).toBe(
      "No picker-visible model overrides are currently loaded.",
    );
  });

  it("validates explicit effort after role precedence without silently clamping or substituting", () => {
    const child = model("limited", { thinkingLevelMap: { high: null } });
    const models = registry([child]);
    expect(() =>
      resolveChildSettings(DEFAULT_CONFIG, undefined, "test/limited", "high", models, child),
    ).toThrow("Supported reasoning efforts:");
    expect(
      resolveChildSettings(
        { ...DEFAULT_CONFIG, roles: { reviewer: { thinking: "low" } } },
        "reviewer",
        "test/limited",
        "high",
        models,
        child,
      ).thinking,
    ).toBe("low");
    expect(
      resolveChildSettings(DEFAULT_CONFIG, undefined, undefined, undefined, models, child, "high")
        .thinking,
    ).toBe("high");
  });
});
