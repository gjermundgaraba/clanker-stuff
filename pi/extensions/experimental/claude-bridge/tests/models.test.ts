import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModels,
  catalogModels,
  claudeCodeModelId,
  effortForReasoning,
} from "../models.js";
import { testModel } from "./helpers.js";

const catalogEntry = (id: string, contextWindow = 200_000): Model<Api> => ({
  id,
  name: id,
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  headers: { "x-api-key": "LEAK" },
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow,
  maxTokens: 8000,
});

const oneM = (id: string): Model<Api> => catalogEntry(id, 1_000_000);

const find = (models: ReadonlyArray<Model<Api>>, id: string): Model<Api> => {
  const model = models.find((candidate) => candidate.id === id);

  if (model === undefined) {
    throw new Error(`${id} missing from the registered models`);
  }

  return model;
};

describe("buildModels", () => {
  it("projects pi-ai's catalog with its list prices and without dated snapshot aliases", () => {
    const models = catalogModels();

    expect(models.some((model) => /-20\d{6}$/u.test(model.id))).toBe(false);
    expect(models.map((model) => model.id)).toStrictEqual(
      expect.arrayContaining([
        "claude-opus-5",
        "claude-fable-5-1",
        "claude-haiku-4-5",
      ])
    );

    const catalog = getBuiltinModels("anthropic");

    for (const model of models) {
      expect(model.cost.output).toBeGreaterThan(0);
      expect(model.cost).toStrictEqual(find(catalog, model.id).cost);
    }
  });

  it("retargets api, provider and baseUrl onto claude-bridge and strips catalog headers", () => {
    const [projected] = buildModels([catalogEntry("claude-haiku-4-5")]);

    expect(projected).toStrictEqual({
      id: "claude-haiku-4-5",
      name: "claude-haiku-4-5",
      api: "claude-bridge",
      provider: "claude-bridge",
      baseUrl: "",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8000,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
  });

  it("sorts newest generation first within each family", () => {
    const models = buildModels([
      oneM("claude-opus-4-7"),
      oneM("claude-opus-5"),
      oneM("claude-sonnet-5"),
      oneM("claude-opus-4-6"),
    ]);

    expect(models.map((model) => model.id)).toStrictEqual([
      "claude-opus-5",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
    ]);
  });

  it("keeps the bare id of a dated snapshot alias", () => {
    const models = buildModels([
      catalogEntry("claude-opus-4-5-20251101"),
      catalogEntry("claude-opus-4-5"),
    ]);

    expect(models.map((model) => model.id)).toStrictEqual(["claude-opus-4-5"]);
  });

  it("sinks unknown families below the known ones", () => {
    const models = buildModels([oneM("claude-proxy-x"), oneM("claude-opus-5")]);

    expect(models.map((model) => model.id)).toStrictEqual([
      "claude-opus-5",
      "claude-proxy-x",
    ]);
  });

  it("forwards pi-ai's thinkingLevelMap verbatim and fabricates none", () => {
    const models = buildModels([
      {
        ...catalogEntry("claude-sonnet-5"),
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      catalogEntry("claude-haiku-4-5"),
    ]);

    expect(find(models, "claude-sonnet-5").thinkingLevelMap).toStrictEqual({
      xhigh: "xhigh",
      max: "max",
    });
    expect(find(models, "claude-haiku-4-5")).not.toHaveProperty(
      "thinkingLevelMap"
    );
  });
});

describe("claudeCodeModelId", () => {
  it("sends [1m] for a measured model whose effective window is above 200K", () => {
    expect(
      claudeCodeModelId({ id: "claude-opus-5-5", contextWindow: 1_000_000 })
    ).toBe("claude-opus-5-5[1m]");
    expect(
      claudeCodeModelId({ id: "claude-opus-5-5", contextWindow: 400_000 })
    ).toBe("claude-opus-5-5[1m]");
  });

  it("sends the bare id when a measured model's effective window is 200K or less", () => {
    expect(
      claudeCodeModelId({ id: "claude-opus-5-5", contextWindow: 200_000 })
    ).toBe("claude-opus-5-5");
    expect(
      claudeCodeModelId({ id: "claude-opus-5-5", contextWindow: 150_000 })
    ).toBe("claude-opus-5-5");
  });

  it("serves unmeasured ids bare even when the effective window is above 200K", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-future-9-9",
    ]) {
      expect(claudeCodeModelId({ id, contextWindow: 1_000_000 })).toBe(id);
    }
  });
});

describe("the registered context window", () => {
  const models = catalogModels();

  it("matches what Claude Code serves by default", () => {
    expect(find(models, "claude-opus-5").contextWindow).toBe(1_000_000);
    expect(find(models, "claude-opus-4-7").contextWindow).toBe(1_000_000);
    expect(find(models, "claude-fable-5-1").contextWindow).toBe(1_000_000);
    expect(find(models, "claude-sonnet-4-5").contextWindow).toBe(200_000);
  });

  it("overrides the window pi-ai declares for unmeasured models", () => {
    const declared = getBuiltinModels("anthropic").find(
      (model) => model.id === "claude-opus-4-6"
    );

    expect(declared?.contextWindow).toBe(1_000_000);
    expect(find(models, "claude-opus-4-6").contextWindow).toBe(200_000);
  });

  it("preserves the catalog display name without baking 1M into it", () => {
    expect(find(models, "claude-opus-5").name).toBe("Claude Opus 5");
    expect(find(models, "claude-opus-4-6").name).toBe("Claude Opus 4.6");
    expect(find(models, "claude-haiku-4-5").name).toBe(
      "Claude Haiku 4.5 (latest)"
    );
  });
});

const mapped = (
  thinkingLevelMap: Model<Api>["thinkingLevelMap"]
): Model<Api> => ({
  ...testModel("claude-fable-5-1"),
  ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
});

describe("effortForReasoning", () => {
  it("uses the model's thinkingLevelMap when it names the level", () => {
    const fable = mapped({ xhigh: "xhigh", max: "max" });

    expect(effortForReasoning(fable, "max")).toBe("max");
    expect(effortForReasoning(fable, "xhigh")).toBe("xhigh");
  });

  it("falls back to the generic table for levels the map leaves unnamed", () => {
    const fable = mapped({ xhigh: "xhigh", max: "max" });
    const unmapped = mapped(undefined);

    expect(effortForReasoning(fable, "high")).toBe("high");
    expect(effortForReasoning(unmapped, "minimal")).toBe("low");
    expect(effortForReasoning(unmapped, "xhigh")).toBe("max");
    expect(effortForReasoning(unmapped, "max")).toBe("max");
  });

  it("sends no effort for an unsupported, unrecognized or absent level", () => {
    const model = mapped({ minimal: null, xhigh: "turbo" });

    expect(effortForReasoning(model, "minimal")).toBeUndefined();
    expect(effortForReasoning(model, "xhigh")).toBeUndefined();
    expect(effortForReasoning(model, undefined)).toBeUndefined();
  });
});
