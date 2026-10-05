import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG, parseConfig, resolveChildSettings } from "../config.js";

const model = (provider: string, id: string, reasoning = false) =>
  fauxProvider({ models: [{ id, reasoning }], provider }).getModel();

const registryOf = (...models: ReturnType<typeof model>[]) => ({
  find: (provider: string, id: string) =>
    models.find((candidate) => candidate.provider === provider && candidate.id === id),
  getAvailable: () => models,
});

const request = { agentType: undefined, model: undefined, thinking: undefined };

describe(parseConfig, () => {
  it("accepts the strict version 2 shape and fills defaults", () => {
    expect(
      parseConfig({
        delegation: "proactive",
        max_concurrent_threads_per_session: 2,
        roles: { researcher: { description: "Find evidence.", thinking: "high" } },
        version: 2,
      }),
    ).toStrictEqual({
      delegation: "proactive",
      maxConcurrent: 2,
      roles: { researcher: { description: "Find evidence.", thinking: "high" } },
    });
    expect(parseConfig({ version: 2 })).toStrictEqual(DEFAULT_CONFIG);
  });

  it.each([
    { version: 1 },
    { protocols: { "*": "v2" }, version: 2 },
    { max_concurrent_threads_per_session: 0, version: 2 },
    { roles: { "My Role": {} }, version: 2 },
    { roles: { reviewer: { nicknames: ["Scout"] } }, version: 2 },
  ])("rejects retired or invalid configuration %j", (value) => {
    expect(() => parseConfig(value)).toThrow("strict version 2 object");
  });
});

describe(resolveChildSettings, () => {
  const parent = model("parent", "parent-model", true);

  it("inherits the parent model and reasoning when nothing is requested", () => {
    expect(
      resolveChildSettings(DEFAULT_CONFIG, request, {
        model: parent,
        registry: registryOf(parent),
        thinking: "low",
      }),
    ).toStrictEqual({ instructions: undefined, model: parent, thinking: "low" });
  });

  it("lets a configured role fix model, reasoning, and instructions over explicit requests", () => {
    const roleModel = model("other", "role-model", true);
    const requested = model("other", "requested", true);

    const config = {
      ...DEFAULT_CONFIG,
      roles: {
        reviewer: { instructions: "Review.", model: "other/role-model", thinking: "high" as const },
      },
    };

    expect(
      resolveChildSettings(
        config,
        { agentType: "reviewer", model: "other/requested", thinking: "low" },
        { model: parent, registry: registryOf(parent, roleModel, requested), thinking: "off" },
      ),
    ).toStrictEqual({ instructions: "Review.", model: roleModel, thinking: "high" });
  });

  it("allows another provider with inherited history", () => {
    const other = model("other", "model");

    expect(
      resolveChildSettings(
        DEFAULT_CONFIG,
        { ...request, model: "other/model" },
        { model: parent, registry: registryOf(parent, other), thinking: undefined },
      ).model,
    ).toBe(other);
  });

  it("names available models for an unknown override and rejects unqualified ids", () => {
    const parents = { model: parent, registry: registryOf(parent), thinking: undefined };

    expect(() =>
      resolveChildSettings(DEFAULT_CONFIG, { ...request, model: "other/missing" }, parents),
    ).toThrow(
      "Unknown model `other/missing` for spawn_agent. Available models: parent/parent-model",
    );

    for (const value of ["parent-model", "/parent-model", "parent/"]) {
      expect(() =>
        resolveChildSettings(DEFAULT_CONFIG, { ...request, model: value }, parents),
      ).toThrow("provider/model-id");
    }
  });

  it("rejects unknown roles, unsupported reasoning, and a missing model", () => {
    const plain = model("parent", "plain");
    const parents = { model: plain, registry: registryOf(plain), thinking: undefined };

    expect(() =>
      resolveChildSettings(DEFAULT_CONFIG, { ...request, agentType: "constructor" }, parents),
    ).toThrow("Unknown agent_type: constructor");
    expect(() =>
      resolveChildSettings(DEFAULT_CONFIG, { ...request, thinking: "high" }, parents),
    ).toThrow("Reasoning effort `high` is not supported for model `plain`");
    expect(() =>
      resolveChildSettings(DEFAULT_CONFIG, request, { ...parents, model: undefined }),
    ).toThrow("No model is selected");
  });
});
