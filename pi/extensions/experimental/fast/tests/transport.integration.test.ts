import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createFastMode } from "../mode.js";

const BodySchema = Type.Object(
  { model: Type.String(), service_tier: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

describe("native OpenAI Responses Fast hook", () => {
  it("sends priority only when on through the real native provider without replacing inference", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fast-native-"));
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", () =>
      Promise.resolve({
        type: "oauth",
        access: "test-subscription",
        refresh: "unused",
        expires: Date.now() + 3_600_000,
      }),
    );
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
    const native = runtime.getProvider("openai");

    if (native === undefined) throw new Error("Missing native OpenAI provider");

    const model: Model<"openai-responses"> = {
      api: "openai-responses",
      provider: "openai",
      id: "arbitrary-native-model",
      name: "Fixture",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const tiers: (string | undefined)[] = [];
    const endpoints: string[] = [];
    const authorization: (string | null)[] = [];

    const fetchResponse: typeof fetch = async (url, init) => {
      endpoints.push(url instanceof Request ? url.url : url instanceof URL ? url.href : url);
      authorization.push(new Headers(init?.headers).get("authorization"));

      if (typeof init?.body !== "string") throw new Error("Expected native SDK JSON request body");
      const raw: unknown = JSON.parse(init.body);
      const body = Value.Parse(BodySchema, raw);
      tiers.push(body.service_tier);
      expect(body.model).toBe(model.id);

      if (tiers.length === 3)
        return new Response(
          JSON.stringify({
            error: { message: "Priority unavailable", type: "invalid_request_error" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );

      return new Response(
        `data: ${JSON.stringify({
          type: "response.created",
          sequence_number: 0,
          response: { id: "fixture", status: "in_progress", service_tier: "priority" },
        })}\n\ndata: ${JSON.stringify({
          type: "response.completed",
          sequence_number: 0,
          response: {
            id: "fixture",
            status: "completed",
            service_tier: "default",
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };

    runtime.registerNativeProvider({
      ...native,
      getModels: () => [model],
      getAllModels: () => [model],
      streamSimple: (selected, context, options) =>
        native.streamSimple(selected, context, { ...options, fetch: fetchResponse }),
    });
    await runtime.refresh({ allowNetwork: false });

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const resourceLoader = new DefaultResourceLoader({
      agentDir: directory,
      cwd: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          const mode = createFastMode(pi, path.join(directory, "fast.json"));

          pi.registerCommand("fast", {
            description: "Toggle fixture",
            handler: async (args, ctx) => mode.toggle(args, ctx),
          });
          pi.on("session_start", (event, ctx) => mode.start(event, ctx));
          pi.on("before_provider_request", (event, ctx) => mode.payload(event, ctx));
          pi.on("session_shutdown", (_event, ctx) => mode.stop(ctx));
        },
      ],
    });

    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    });

    try {
      await session.bindExtensions({});
      await session.prompt("/fast");
      await session.prompt("One.");
      await session.prompt("/fast");
      await session.prompt("Two.");
      expect(tiers).toStrictEqual(["priority", undefined]);
      expect(endpoints).toStrictEqual([
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
      ]);
      expect(authorization).toStrictEqual(["Bearer test-subscription", "Bearer test-subscription"]);
      expect(
        session.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.stopReason),
      ).toStrictEqual(["stop", "stop"]);

      await session.prompt("/fast");
      await session.prompt("Rejected.");
      expect(tiers).toStrictEqual(["priority", undefined, "priority"]);
      const rejected = session.messages.at(-1);

      expect(rejected?.role).toBe("assistant");

      if (rejected?.role !== "assistant") throw new Error("Missing backend rejection");
      expect(rejected.stopReason).toBe("error");
      expect(rejected.errorMessage).toContain("Priority unavailable");
    } finally {
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
