import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CONFIG,
  parseConfig,
  parseModelOverride,
  resolveChildSettings,
} from "../config.js";

const model = (provider: string, id: string) =>
  fauxProvider({ models: [{ id }], provider }).getModel();

describe(parseConfig, () => {
  it("accepts strict protocol, role, and prompt configuration", () => {
    expect(
      parseConfig({
        expose_spawn_agent_model_overrides: false,
        max_concurrent_threads_per_session: 2,
        prompts: {
          child: "Shared child identity.",
          delegation: "proactive",
          v1: { root: "V1 root guidance." },
          v2: {
            child: "V2-capable child guidance.",
            root: "V2 root guidance.",
          },
        },
        protocols: { "*": "auto", "provider/model": "v2" },
        roles: {
          researcher: {
            description: "Find evidence.",
            instructions: "Research",
            model: "parent/model",
            nicknames: ["Scout"],
            thinking: "high",
          },
        },
        version: 1,
      }),
    ).toMatchObject({
      expose_spawn_agent_model_overrides: false,
      max_concurrent_threads_per_session: 2,
      prompts: {
        child: "Shared child identity.",
        delegation: "proactive",
        v1: { root: "V1 root guidance." },
        v2: {
          child: "V2-capable child guidance.",
          root: "V2 root guidance.",
        },
      },
      version: 1,
    });
    expect(() => parseConfig({ unknown: true, version: 1 })).toThrow("strict");

    for (const max of [0, 1.5]) {
      expect(() =>
        parseConfig({
          max_concurrent_threads_per_session: max,
          version: 1,
        }),
      ).toThrow("strict");
    }
  });

  it("resolves explicit qualified references across providers without aliases", () => {
    const models = [
      model("parent", "shared"),
      model("other", "shared"),
      model("other", "unique"),
      model("parent", "nested/model"),
    ];

    const registry = {
      getAvailable: () => [],
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
    };

    expect(parseModelOverride(undefined, registry, models[0])).toBe(models[0]);
    expect(parseModelOverride("parent/shared", registry, models[0])).toBe(models[0]);
    expect(parseModelOverride("other/shared", registry, models[0])).toBe(models[1]);
    expect(parseModelOverride("parent/nested/model", registry)).toBe(models[3]);
    expect(parseModelOverride("other/unique", registry)).toBe(models[2]);

    for (const value of ["shared", "", "/shared", "parent/"])
      expect(() => parseModelOverride(value, registry)).toThrow("provider/model-id");
    expect(() => parseModelOverride("other/missing", registry)).toThrow("Unknown model");
  });

  it("rejects a second provider-selection field", () => {
    expect(() =>
      parseConfig({
        roles: { reviewer: { model: "parent/model", provider: "other" } },
        version: 1,
      }),
    ).toThrow("strict version 1 object");
  });

  it("rejects role names that do not match the public agent_type grammar", () => {
    expect(() =>
      parseConfig({
        roles: { "My Role": { description: "invalid" } },
        version: 1,
      }),
    ).toThrow("config must be a strict version 1 object");
  });

  it("resolves qualified roles and rejects cross-provider history forks", () => {
    const parentRoleModel = model("parent", "role-model");
    const requestedProviderRoleModel = model("requested", "role-model");
    const requested = model("requested", "request-model");

    const registry = {
      getAvailable: () => [],
      find: (provider: string, id: string) =>
        [parentRoleModel, requestedProviderRoleModel, requested].find(
          (model) => model.provider === provider && model.id === id,
        ),
    };

    expect(
      resolveChildSettings(
        {
          ...structuredClone(DEFAULT_CONFIG),
          roles: { reviewer: { model: "requested/role-model" } },
        },
        "reviewer",
        undefined,
        undefined,
        registry,
        model("parent", "parent-model"),
        "off",
      ).model,
    ).toBe(requestedProviderRoleModel);
    expect(() =>
      resolveChildSettings(
        DEFAULT_CONFIG,
        undefined,
        "requested/request-model",
        undefined,
        registry,
        parentRoleModel,
        "off",
        true,
      ),
    ).toThrow("no inherited history");
  });
});
