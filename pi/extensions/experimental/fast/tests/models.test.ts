import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { canRequestPriority } from "../models.js";

describe("best-effort native priority gate", () => {
  it("permits every registry-resolved native Responses model with subscription OAuth", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });

    const models = runtime
      .getModels("openai")
      .filter(
        (model) =>
          model.api === "openai-responses" && model.baseUrl === "https://api.openai.com/v1",
      );

    const first = models[0];

    if (first === undefined) throw new Error("Missing native OpenAI Responses models");

    const native = runtime.getProvider("openai");
    const oauth = native?.auth.oauth;

    if (native === undefined || oauth === undefined)
      throw new Error("Missing native subscription OAuth metadata");

    for (const model of [...models, { ...first, id: "future-native-model" }]) {
      const host = createExtensionHost(() => {}, { model });
      await host.ready;

      const registry = {
        find: () => model,
        isUsingOAuth: () => true,
        getProvider: (provider: string) => runtime.getProvider(provider),
      };

      const ctx = host.createContext({ modelRegistry: registry });

      expect(canRequestPriority(ctx), model.id).toBe(true);
      expect(
        canRequestPriority(
          host.createContext({
            modelRegistry: { ...registry, isUsingOAuth: () => false },
          }),
        ),
      ).toBe(false);
      expect(
        canRequestPriority(
          host.createContext({
            modelRegistry: { ...registry, getProvider: () => undefined },
          }),
        ),
      ).toBe(false);
      expect(
        canRequestPriority(
          host.createContext({
            modelRegistry: { ...registry, find: () => undefined },
          }),
        ),
      ).toBe(false);

      expect(
        canRequestPriority(
          host.createContext({
            modelRegistry: {
              ...registry,
              getProvider: () => ({
                ...native,
                auth: { ...native.auth, oauth: { ...oauth, isSubscription: false } },
              }),
            },
          }),
        ),
      ).toBe(false);

      for (const changed of [
        { ...model, provider: "custom" },
        { ...model, api: "openai-completions" as const },
        { ...model, baseUrl: "https://custom.invalid/v1" },
        { ...model, baseUrl: "https://api.openai.com/v1/" },
      ]) {
        expect(
          canRequestPriority(host.createContext({ model: changed, modelRegistry: registry })),
        ).toBe(false);
        expect(
          canRequestPriority(
            host.createContext({
              modelRegistry: { ...registry, find: () => changed },
            }),
          ),
        ).toBe(false);
      }
    }
  });
});
