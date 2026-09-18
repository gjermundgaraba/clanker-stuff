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
  it("describes affordable V1 children under V2 with supported efforts and native defaults", () => {
    const child = model("small", {
      multiAgentVersion: "v1",
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: null },
      spawnAgentMetadata: {
        description: "Fast and affordable agentic coding model.",
        defaultReasoningEffort: "medium",
        serviceTiers: ["priority"],
        showInPicker: true,
      },
    });

    const models = registry([child]);
    expect(spawnModelsDescription(models, "test", "v2")).toBe(
      "Available model overrides (optional; inherited parent model is preferred):\n" +
        "- `small`: Fast and affordable agentic coding model. Reasoning efforts: low, medium (default). Service tiers: priority.",
    );
    expect(parseModelOverride("small", models, child, "v2")).toBe(child);
  });

  it("caps suggestions, not explicit selections; excludes hidden, disabled and other-provider models", () => {
    const hidden = model("hidden", {
      spawnAgentMetadata: { showInPicker: false, serviceTiers: [] },
    });

    const disabled = model("disabled", { multiAgentVersion: "disabled" });
    const visible = Array.from({ length: 7 }, (_, n) => model(`option-${n}`));

    const models = registry([
      hidden,
      disabled,
      model("foreign", { provider: "other" }),
      ...visible,
    ]);

    expect(suggestedSpawnModels(models, "test", "v2").map((m) => m.id)).toEqual(
      visible.slice(0, 5).map((m) => m.id),
    );
    expect(parseModelOverride("option-6", models, visible[0], "v2")).toBe(visible[6]);
    expect(parseModelOverride("hidden", models, visible[0], "v2")).toBe(hidden);
    expect(parseModelOverride("disabled", models, visible[0], "v1")).toBe(disabled);

    for (const id of ["disabled", "foreign", "invented"]) {
      expect(() => parseModelOverride(id, models, visible[0], "v2")).toThrow(
        `Unknown model \`${id}\` for spawn_agent. Available models: option-0, option-1, option-2, option-3, option-4`,
      );
    }
  });

  it("uses the effective picker snapshot and does not invent metadata for generic providers", () => {
    const one = model("one");
    const two = model("two");
    const models = registry([one, two], [two]);
    expect(suggestedSpawnModels(models, "test", "v1")).toEqual([two]);
    expect(spawnModelsDescription(models, "test", "v1")).not.toContain("default)");
    expect(spawnModelsDescription(models, "missing", "v2")).toBe(
      "No picker-visible model overrides are currently loaded.",
    );
  });

  it("validates explicit effort after role precedence without silently clamping or substituting", () => {
    const child = model("limited", { thinkingLevelMap: { high: null } });
    const models = registry([child]);
    expect(() =>
      resolveChildSettings(DEFAULT_CONFIG, undefined, "limited", "high", models, child),
    ).toThrow("Supported reasoning efforts:");
    expect(
      resolveChildSettings(
        { ...DEFAULT_CONFIG, roles: { reviewer: { thinking: "low" } } },
        "reviewer",
        "limited",
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
