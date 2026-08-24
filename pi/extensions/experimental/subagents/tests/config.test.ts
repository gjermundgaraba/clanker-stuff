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
            model: "model",
            nicknames: ["Scout"],
            provider: "provider",
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

  it("accepts Codex-style bare model ids when resolution is unambiguous", () => {
    const models = [model("parent", "shared"), model("other", "shared"), model("other", "unique")];
    const registry = {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAll: () => models,
    };

    expect(parseModelOverride("shared", registry, models[0])?.provider).toBe("parent");
    expect(parseModelOverride("unique", registry, models[0])).toBe(models[2]);
    expect(() => parseModelOverride("shared", registry)).toThrow("Ambiguous model");
  });

  it("requires provider-selecting roles to name their model", () => {
    expect(() =>
      parseConfig({
        roles: { reviewer: { provider: "other" } },
        version: 1,
      }),
    ).toThrow("Role reviewer must set model when provider is set");
  });

  it("rejects role names that do not match the public agent_type grammar", () => {
    expect(() =>
      parseConfig({
        roles: { "My Role": { description: "invalid" } },
        version: 1,
      }),
    ).toThrow("config must be a strict version 1 object");
  });

  it("resolves a role's bare model against the parent provider", () => {
    const parentRoleModel = model("parent", "role-model");
    const requestedProviderRoleModel = model("requested", "role-model");
    const requested = model("requested", "request-model");
    const registry = {
      find: (provider: string, id: string) =>
        [parentRoleModel, requestedProviderRoleModel, requested].find(
          (model) => model.provider === provider && model.id === id,
        ),
      getAll: () => [parentRoleModel, requestedProviderRoleModel, requested],
    };

    expect(
      resolveChildSettings(
        {
          ...structuredClone(DEFAULT_CONFIG),
          roles: { reviewer: { model: "role-model" } },
        },
        "reviewer",
        "requested/request-model",
        undefined,
        registry,
        model("parent", "parent-model"),
        "off",
      ).model,
    ).toBe(parentRoleModel);
  });
});
