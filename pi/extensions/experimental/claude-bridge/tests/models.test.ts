import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  applyLongContext,
  buildModels,
  catalogModels,
  claudeCodeModelId,
  effortForReasoning,
  resolveClaudeCodeRuntimeModel,
} from "../models.js";
import type { ProviderChatModelConfig } from "../models.js";
import { testModel } from "./helpers.js";

// A pi-ai catalog entry: priced, and carrying the api/provider/baseUrl/headers fields
// that must not leak into the provider registration.
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

const find = (
  models: readonly ProviderChatModelConfig[],
  id: string
): ProviderChatModelConfig => {
  const model = models.find((candidate) => candidate.id === id);

  if (model === undefined) {
    throw new Error(`${id} missing from the registered models`);
  }

  return model;
};

describe("buildModels", () => {
  it("projects pi-ai's catalog onto unpriced registrations without dated snapshot aliases", () => {
    const models = catalogModels();

    expect(models.some((model) => /-20\d{6}$/u.test(model.id))).toBe(false);
    expect(models.map((model) => model.id)).toStrictEqual(
      expect.arrayContaining([
        "claude-opus-5",
        "claude-fable-5-1",
        "claude-haiku-4-5",
      ])
    );

    for (const model of models) {
      expect(model.cost).toStrictEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });

  it("strips the catalog's api, provider, baseUrl and headers", () => {
    const [projected] = buildModels([catalogEntry("claude-haiku-4-5")]);

    expect(projected).toStrictEqual({
      id: "claude-haiku-4-5",
      name: "claude-haiku-4-5",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

describe("resolveClaudeCodeRuntimeModel", () => {
  it("sends [1m] for an id measured to serve 1M", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-opus-5-5")).toStrictEqual({
      cliModelId: "claude-opus-5-5[1m]",
      contextWindow: 1_000_000,
    });
  });

  it("serves unmeasured ids bare at 200K even when pi-ai declares 1M", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-sonnet-4-5")).toStrictEqual({
      cliModelId: "claude-sonnet-4-5",
      contextWindow: 200_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-future-9-9")).toStrictEqual({
      cliModelId: "claude-future-9-9",
      contextWindow: 200_000,
    });
  });

  // Both serve 1M only on Max or with metered Extra Usage; an unentitled [1m] fails.
  it("keeps opus-4-6 and sonnet-4-6 at 200K", () => {
    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(resolveClaudeCodeRuntimeModel(id)).toStrictEqual({
        cliModelId: id,
        contextWindow: 200_000,
      });
    }
  });

  it("names the same id through claudeCodeModelId", () => {
    expect(claudeCodeModelId("claude-opus-5")).toBe("claude-opus-5[1m]");
    expect(claudeCodeModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
});

describe("applyLongContext", () => {
  const models = catalogModels();

  it("registers the window the bridge requests", () => {
    const pro = applyLongContext(models);

    expect(find(pro, "claude-opus-5").contextWindow).toBe(1_000_000);
    expect(find(pro, "claude-opus-4-7").contextWindow).toBe(1_000_000);
    expect(find(pro, "claude-fable-5-1").contextWindow).toBe(1_000_000);
    expect(find(pro, "claude-sonnet-4-5").contextWindow).toBe(200_000);
  });

  it("leaves pi-ai's own table as it declared it", () => {
    const registered = applyLongContext(models);

    expect(find(registered, "claude-opus-4-6").contextWindow).toBe(200_000);
    expect(find(models, "claude-opus-4-6").contextWindow).toBe(1_000_000);
  });

  it("labels exactly the registered 1M models", () => {
    const registered = applyLongContext(models);

    expect(find(registered, "claude-opus-5").name).toBe("Claude Opus 5 1M");
    expect(find(registered, "claude-opus-4-6").name).toBe("Claude Opus 4.6");
    expect(find(registered, "claude-haiku-4-5").name).toBe(
      "Claude Haiku 4.5 (latest)"
    );
  });

  it("does not label a name that already says 1M twice", () => {
    const [labeled] = applyLongContext(
      buildModels([{ ...oneM("claude-opus-5"), name: "Claude Opus 5 (1M)" }])
    );

    expect(labeled?.name).toBe("Claude Opus 5 (1M)");
  });

  it("returns an entry that needs no change as is", () => {
    const [unchanged] = buildModels([catalogEntry("claude-haiku-4-5")]);

    if (unchanged === undefined) {
      throw new Error("projection dropped claude-haiku-4-5");
    }

    const [registered] = applyLongContext([unchanged]);

    expect(registered).toBe(unchanged);
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
