import { zstdDecompressSync } from "node:zlib";

import type { Context, FetchFunction, Provider } from "@earendil-works/pi-ai";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  RETAINED_USER_IMAGE_PLACEHOLDER,
  parseCheckpoint,
} from "../checkpoint.js";
import {
  buildContextFrameDiagnostic,
  buildLifecycleCheckpoint,
  buildLifecycleSource,
  freshAssistantUsageTokens,
  hasResolvedLifecycleAuth,
  isInlineInstallationResolvable,
  isLifecycleInstallationResolvable,
  isSupportedLifecycleModel,
  isRetryableLifecycleFailure,
  mergeRemoteCompactionHeaders,
  mergeRemoteCompactionFeatureHeader,
  parseFinalizedResponsesEnvelope,
  runRegisteredProviderCompaction,
  shouldCompactFinalizedInput,
} from "../lifecycle.js";
import type { LifecycleExecutionSuccess } from "../lifecycle.js";
import { NON_VISION_USER_IMAGE_PLACEHOLDER } from "../replay.js";
import { SPIKE_API_KEY, SPIKE_MODEL } from "./fixtures.js";

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const compactionResponse = (encryptedContent = "opaque-new") => {
  const compaction = {
    encrypted_content: encryptedContent,
    id: "cmp_lifecycle",
    type: "compaction",
  };
  return new Response(
    [
      sse({
        response: { id: "resp_lifecycle", status: "in_progress" },
        type: "response.created",
      }),
      sse({
        item: compaction,
        output_index: 0,
        type: "response.output_item.done",
      }),
      sse({
        response: {
          id: "resp_lifecycle",
          output: [compaction],
          status: "completed",
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 23,
          },
        },
        type: "response.completed",
      }),
      "data: [DONE]\n\n",
    ].join(""),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }
  );
};

const malformedResponse = () =>
  new Response(
    sse({
      response: { id: "resp_bad", status: "completed" },
      type: "response.completed",
    }),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }
  );

const requestJson = (body: unknown, headers: Headers) => {
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, unknown>;
  }
  if (!(body instanceof Uint8Array)) {
    throw new Error("Unexpected request body");
  }
  const bytes =
    headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(body)
      : body;
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
};

const createRegistry = async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerProvider("openai-codex", {
    api: SPIKE_MODEL.api,
    apiKey: SPIKE_API_KEY,
    baseUrl: SPIKE_MODEL.baseUrl,
    models: [
      {
        api: SPIKE_MODEL.api,
        contextWindow: SPIKE_MODEL.contextWindow,
        cost: SPIKE_MODEL.cost,
        id: SPIKE_MODEL.id,
        input: SPIKE_MODEL.input,
        maxTokens: SPIKE_MODEL.maxTokens,
        name: SPIKE_MODEL.name,
        reasoning: SPIKE_MODEL.reasoning,
      },
    ],
  });
  await runtime.setRuntimeApiKey("openai-codex", SPIKE_API_KEY);
  return new ModelRegistry(runtime);
};

const userInput = (text: string) => ({
  content: [{ text, type: "input_text" as const }],
  role: "user" as const,
  type: "message" as const,
});

const attemptOptions = async (fetch: FetchFunction) => {
  const registry = await createRegistry();
  const provider = registry.getProvider("openai-codex");
  if (!provider) {
    throw new Error("Registered provider is unavailable");
  }
  vi.stubGlobal("fetch", fetch);
  return {
    apiKey: SPIKE_API_KEY,
    context: {
      messages: [
        {
          content: [{ text: "new user", type: "text" }],
          role: "user",
          timestamp: 1,
        },
      ],
      systemPrompt: "lifecycle instructions",
      tools: [
        {
          description: "Lifecycle tool",
          name: "lifecycle_tool",
          parameters: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
        },
      ],
    } satisfies Context,
    env: { PHASE_TWO: "yes" },
    headers: {
      "x-codex-beta-features": "existing_feature",
      "x-phase-two": "yes",
    },
    inputPrefix: [
      userInput("retained user"),
      {
        content: [
          {
            image_url: "data:image/png;base64,REQUEST_IMAGE_SECRET",
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
      { encrypted_content: "opaque-old", type: "compaction" },
    ],
    model: SPIKE_MODEL,
    provider,
    sessionId: "phase-two-session",
    signal: new AbortController().signal,
    thinkingLevel: "high" as const,
  };
};

const withProviderResponseId = (provider: Provider, responseId?: string) => {
  const streamSimple: Provider["streamSimple"] = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const forward = async () => {
      for await (const event of provider.streamSimple(
        model,
        context,
        options
      )) {
        if (event.type !== "done") {
          stream.push(event);
          continue;
        }
        const message = { ...event.message };
        if (responseId === undefined) {
          delete message.responseId;
        } else {
          message.responseId = responseId;
        }
        stream.push({ ...event, message });
      }
    };
    void forward();
    return stream;
  };
  return new Proxy(provider, {
    get(target, property) {
      if (property === "streamSimple") {
        return streamSimple;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const entry = (
  id: string,
  value: Record<string, unknown>,
  parentId: string | null = null
): SessionEntry =>
  ({
    id,
    parentId,
    timestamp: "2026-07-30T12:00:00.000Z",
    ...value,
  }) as SessionEntry;

describe("registered lifecycle remote execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the provider envelope and changes only normalized input plus one trigger", async () => {
    let wireBody: Record<string, unknown> | undefined;
    let wireHeaders: Headers | undefined;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      wireHeaders = new Headers(init?.headers);
      wireBody = requestJson(init?.body, wireHeaders);
      return compactionResponse();
    });

    const result = await runRegisteredProviderCompaction(
      await attemptOptions(fetch)
    );
    expect({
      beta: wireHeaders?.get("x-codex-beta-features"),
      envHeader: wireHeaders?.get("x-phase-two"),
      input: wireBody?.input,
      instructions: wireBody?.instructions,
      model: wireBody?.model,
      ok: result.ok,
      reasoning: wireBody?.reasoning,
      sessionId: wireHeaders?.get("session-id"),
      tools: wireBody?.tools,
    }).toMatchObject({
      beta: "existing_feature,remote_compaction_v2",
      envHeader: "yes",
      input: [
        userInput("retained user"),
        userInput(NON_VISION_USER_IMAGE_PLACEHOLDER),
        { encrypted_content: "opaque-old", type: "compaction" },
        {
          content: [{ text: "new user", type: "input_text" }],
          role: "user",
        },
        { type: "compaction_trigger" },
      ],
      instructions: "lifecycle instructions",
      model: SPIKE_MODEL.id,
      ok: true,
      reasoning: { effort: "high", summary: "auto" },
      sessionId: "phase-two-session",
      tools: [{ description: "Lifecycle tool", name: "lifecycle_tool" }],
    });
    expect(JSON.stringify(wireBody)).not.toContain("REQUEST_IMAGE_SECRET");
    expect(
      result.ok
        ? {
            responseId: result.responseId,
            sourceTokens: result.estimatedSourceTokens,
            usage: result.usage,
          }
        : result
    ).toMatchObject({
      responseId: "resp_lifecycle",
      sourceTokens: expect.any(Number),
      usage: {
        cacheRead: 4,
        input: 16,
        output: 3,
        totalTokens: 23,
      },
    });
  });

  it("does not follow redirects with the compaction request body", async () => {
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        headers: { location: "https://redirect.invalid/collect" },
        status: 307,
      });
    });

    const result = await runRegisteredProviderCompaction(
      await attemptOptions(fetch)
    );

    expect({
      fetches: fetch.mock.calls.length,
      result,
    }).toStrictEqual({
      fetches: 1,
      result: {
        failure: { kind: "http", status: 307 },
        ok: false,
      },
    });
  });

  it("retries only eligible failures and caps execution at three attempts", async () => {
    const eventuallyFetch = vi.fn<FetchFunction>(async () => {
      if (eventuallyFetch.mock.calls.length < 3) {
        throw new TypeError("network unavailable");
      }
      return compactionResponse();
    });
    const eventual = await runRegisteredProviderCompaction(
      await attemptOptions(eventuallyFetch)
    );

    const cappedFetch = vi.fn<FetchFunction>(async () => {
      throw new TypeError("network unavailable");
    });
    const capped = await runRegisteredProviderCompaction(
      await attemptOptions(cappedFetch)
    );

    expect({
      capped,
      cappedFetches: cappedFetch.mock.calls.length,
      eventualFetches: eventuallyFetch.mock.calls.length,
      eventualOk: eventual.ok,
      retryMatrix: [
        isRetryableLifecycleFailure({ kind: "network" }),
        isRetryableLifecycleFailure({ kind: "premature" }),
        isRetryableLifecycleFailure({ kind: "http", status: 408 }),
        isRetryableLifecycleFailure({ kind: "http", status: 409 }),
        isRetryableLifecycleFailure({ kind: "http", status: 503 }),
        isRetryableLifecycleFailure({ kind: "http", status: 400 }),
        isRetryableLifecycleFailure({ kind: "http", status: 401 }),
        isRetryableLifecycleFailure({ kind: "http", status: 403 }),
        isRetryableLifecycleFailure({ kind: "http", status: 429 }),
        isRetryableLifecycleFailure({ kind: "invalid-output" }),
      ],
    }).toStrictEqual({
      capped: {
        failure: { kind: "network" },
        ok: false,
      },
      cappedFetches: 3,
      eventualFetches: 3,
      eventualOk: true,
      retryMatrix: [
        true,
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
      ],
    });
  }, 10_000);

  it("does not retry malformed output or cancellation", async () => {
    const malformedFetch = vi.fn<FetchFunction>(async () =>
      malformedResponse()
    );
    const malformed = await runRegisteredProviderCompaction(
      await attemptOptions(malformedFetch)
    );

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const cancelledFetch = vi.fn<FetchFunction>(async () =>
      compactionResponse()
    );
    const cancelledOptions = await attemptOptions(cancelledFetch);
    const cancelled = await runRegisteredProviderCompaction({
      ...cancelledOptions,
      signal: controller.signal,
    });

    expect({
      cancelled,
      cancelledFetches: cancelledFetch.mock.calls.length,
      malformed,
      malformedFetches: malformedFetch.mock.calls.length,
    }).toStrictEqual({
      cancelled: {
        failure: { kind: "abort" },
        ok: false,
      },
      cancelledFetches: 0,
      malformed: {
        failure: { kind: "invalid-output" },
        ok: false,
      },
      malformedFetches: 1,
    });
  });

  it("rejects agent_message before sending a compaction request", async () => {
    const fetch = vi.fn<FetchFunction>(async () => compactionResponse());
    const options = await attemptOptions(fetch);

    const result = await runRegisteredProviderCompaction({
      ...options,
      authoritativeInput: [
        {
          author: "agent",
          content: [{ text: "internal", type: "input_text" }],
          recipient: "user",
          type: "agent_message",
        },
      ],
    });

    expect({ fetches: fetch.mock.calls.length, result }).toStrictEqual({
      fetches: 0,
      result: {
        failure: { kind: "invalid-output" },
        ok: false,
      },
    });
  });

  it("rejects missing or mismatched provider response IDs without retrying", async () => {
    const missingFetch = vi.fn<FetchFunction>(async () => compactionResponse());
    const missingOptions = await attemptOptions(missingFetch);
    const missing = await runRegisteredProviderCompaction({
      ...missingOptions,
      provider: withProviderResponseId(missingOptions.provider),
    });

    const mismatchedFetch = vi.fn<FetchFunction>(async () =>
      compactionResponse()
    );
    const mismatchedOptions = await attemptOptions(mismatchedFetch);
    const mismatched = await runRegisteredProviderCompaction({
      ...mismatchedOptions,
      provider: withProviderResponseId(
        mismatchedOptions.provider,
        "resp_different"
      ),
    });

    expect({
      mismatched,
      mismatchedFetches: mismatchedFetch.mock.calls.length,
      missing,
      missingFetches: missingFetch.mock.calls.length,
    }).toStrictEqual({
      mismatched: {
        failure: { kind: "invalid-output" },
        ok: false,
      },
      mismatchedFetches: 1,
      missing: {
        failure: { kind: "invalid-output" },
        ok: false,
      },
      missingFetches: 1,
    });
  });
});

describe("lifecycle source and checkpoint construction", () => {
  it("uses full active branch history rather than Pi's summary subset", () => {
    const branch = [
      entry("user-old", {
        message: {
          content: [{ text: "old user", type: "text" }],
          role: "user",
          timestamp: 1,
        },
        type: "message",
      }),
      entry(
        "assistant",
        {
          message: {
            api: SPIKE_MODEL.api,
            content: [{ text: "assistant", type: "text" }],
            model: SPIKE_MODEL.id,
            provider: SPIKE_MODEL.provider,
            role: "assistant",
            stopReason: "stop",
            timestamp: 2,
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 0,
                output: 0,
                total: 0,
              },
              input: 1,
              output: 1,
              totalTokens: 2,
            },
          },
          type: "message",
        },
        "user-old"
      ),
      entry(
        "user-new",
        {
          message: {
            content: [{ text: "new user", type: "text" }],
            role: "user",
            timestamp: 3,
          },
          type: "message",
        },
        "assistant"
      ),
    ];

    const source = buildLifecycleSource(branch, SPIKE_MODEL);
    expect({
      contextText: source.contextMessages
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content
                .filter((content) => content.type === "text")
                .map((content) => content.text)
        )
        .join("|"),
      prefix: source.inputPrefix,
      retainedUsers: source.retainedUsers,
    }).toStrictEqual({
      contextText: "old user|assistant|new user",
      prefix: [],
      retainedUsers: [userInput("old user"), userInput("new user")],
    });
  });

  it("ignores corrupt inline state only with safe local Pi provenance", () => {
    const before = entry("before", {
      message: {
        content: [{ text: "before corrupt inline", type: "text" }],
        role: "user",
        timestamp: 1,
      },
      type: "message",
    });
    const corruptInline = entry(
      "corrupt-inline",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: { version: 9 },
        type: "custom",
      },
      "before"
    );
    const tail = entry(
      "tail",
      {
        message: {
          content: [{ text: "after corrupt inline", type: "text" }],
          role: "user",
          timestamp: 2,
        },
        type: "message",
      },
      "corrupt-inline"
    );
    const ordinary = entry(
      "ordinary",
      {
        firstKeptEntryId: "before",
        summary: "authoritative ordinary Pi summary",
        tokensBefore: 10,
        type: "compaction",
      },
      "before"
    );
    const corruptAfterOrdinary = entry(
      "corrupt-after-ordinary",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: { version: 9 },
        type: "custom",
      },
      "ordinary"
    );
    const tailAfterOrdinary = entry(
      "tail-after-ordinary",
      {
        message: {
          content: [{ text: "after ordinary summary", type: "text" }],
          role: "user",
          timestamp: 2,
        },
        type: "message",
      },
      "corrupt-after-ordinary"
    );
    const nativeLifecycle = entry(
      "native-lifecycle",
      {
        details: {
          checkpoint: { version: 9 },
          type: CHECKPOINT_CUSTOM_TYPE,
        },
        firstKeptEntryId: "before",
        summary: "encrypted marker",
        tokensBefore: 10,
        type: "compaction",
      },
      "before"
    );
    const corruptAfterNative = entry(
      "corrupt-after-native",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: { version: 9 },
        type: "custom",
      },
      "native-lifecycle"
    );
    const tailAfterNative = entry(
      "tail-after-native",
      {
        message: {
          content: [{ text: "after native marker", type: "text" }],
          role: "user",
          timestamp: 2,
        },
        type: "message",
      },
      "corrupt-after-native"
    );
    const noPriorCompaction = buildLifecycleSource(
      [before, corruptInline, tail],
      SPIKE_MODEL
    );
    const afterOrdinary = buildLifecycleSource(
      [before, ordinary, corruptAfterOrdinary, tailAfterOrdinary],
      SPIKE_MODEL
    );

    expect({
      afterOrdinary: {
        ignored: afterOrdinary.ignoredInvalidInlineCheckpoint,
        prefix: afterOrdinary.inputPrefix,
      },
      noPriorCompaction: {
        ignored: noPriorCompaction.ignoredInvalidInlineCheckpoint,
        prefix: noPriorCompaction.inputPrefix,
        users: noPriorCompaction.retainedUsers,
      },
    }).toStrictEqual({
      afterOrdinary: {
        ignored: true,
        prefix: [],
      },
      noPriorCompaction: {
        ignored: true,
        prefix: [],
        users: [
          userInput("before corrupt inline"),
          userInput("after corrupt inline"),
        ],
      },
    });
    expect(() =>
      buildLifecycleSource(
        [before, nativeLifecycle, corruptAfterNative, tailAfterNative],
        SPIKE_MODEL
      )
    ).toThrow("active checkpoint boundary is invalid");
    expect(() =>
      buildLifecycleSource([before, nativeLifecycle, tail], SPIKE_MODEL)
    ).toThrow("active checkpoint boundary is invalid");
  });

  it("builds a strict checkpoint without persisting request secrets or source history", () => {
    const usage = {
      cacheRead: 2,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        total: 0,
      },
      input: 10,
      output: 3,
      totalTokens: 13,
    };
    const execution = {
      compaction: {
        encrypted_content: "opaque-checkpoint",
        id: "cmp_checkpoint",
        type: "compaction",
      },
      estimatedSourceTokens: 100,
      ok: true,
      responseId: "resp_checkpoint",
      usage,
    } satisfies LifecycleExecutionSuccess;
    const checkpoint = buildLifecycleCheckpoint({
      execution,
      model: SPIKE_MODEL,
      phase: "overflow-retry",
      reason: "overflow",
      retainedUsers: [
        userInput("retained"),
        {
          content: [
            {
              image_url: "data:image/png;base64,BASE64_CHECKPOINT_SECRET",
              type: "input_image",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
    });
    const serialized = JSON.stringify({
      checkpoint,
      type: CHECKPOINT_CUSTOM_TYPE,
    });
    const lifecycleEntry = entry("checkpoint", {
      details: {
        checkpoint,
        type: CHECKPOINT_CUSTOM_TYPE,
      },
      firstKeptEntryId: "old",
      summary: "local marker",
      tokensBefore: 100,
      type: "compaction",
    });
    const tailEntry = entry(
      "tail",
      {
        message: {
          content: [{ text: "tail user", type: "text" }],
          role: "user",
          timestamp: 2,
        },
        type: "message",
      },
      "checkpoint"
    );
    const repeatedSource = buildLifecycleSource(
      [lifecycleEntry, tailEntry],
      SPIKE_MODEL
    );

    expect({
      encryptedCount: checkpoint.replacement.filter(
        (item) => item.type === "compaction"
      ).length,
      parsed: parseCheckpoint(checkpoint).ok,
      persistedSecrets: [
        "secret prompt must not persist",
        "Bearer ",
        "apiKey",
        "x-codex-beta-features",
        "raw SSE",
        "BASE64_CHECKPOINT_SECRET",
      ].filter((secret) => serialized.includes(secret)),
      phase: checkpoint.phase,
      reason: checkpoint.reason,
      repeatedSource: {
        context: repeatedSource.contextMessages,
        prefix: repeatedSource.inputPrefix,
        retainedUsers: repeatedSource.retainedUsers,
      },
      resolvableInstall: isLifecycleInstallationResolvable(
        [lifecycleEntry, tailEntry],
        checkpoint.response.id,
        checkpoint.replacementSha256
      ),
      response: checkpoint.response,
      sourceTokens: checkpoint.sourceTokens,
    }).toMatchObject({
      encryptedCount: 1,
      parsed: true,
      persistedSecrets: [],
      phase: "overflow-retry",
      reason: "overflow",
      repeatedSource: {
        context: [
          {
            content: [{ text: "tail user", type: "text" }],
            role: "user",
            timestamp: 2,
          },
        ],
        prefix: checkpoint.replacement,
        retainedUsers: [
          userInput("retained"),
          userInput(RETAINED_USER_IMAGE_PLACEHOLDER),
          userInput("tail user"),
        ],
      },
      resolvableInstall: true,
      response: {
        id: "resp_checkpoint",
        usage: {
          cacheRead: 2,
          cacheWrite: 0,
          input: 10,
          output: 3,
          totalTokens: 13,
        },
      },
      sourceTokens: 100,
    });
  });

  it("merges beta features without changing unrelated headers", () => {
    const ordinaryHeaders: Record<string, string | null> = {
      "X-Codex-Beta-Features": "one",
      "x-codex-beta-features": "two",
      "x-delete-me": null,
      "x-other": "preserved",
    };
    mergeRemoteCompactionFeatureHeader(ordinaryHeaders);
    expect({
      authDecisions: [
        hasResolvedLifecycleAuth("token"),
        hasResolvedLifecycleAuth("  "),
        hasResolvedLifecycleAuth(),
      ],
      headers: mergeRemoteCompactionHeaders(
        {
          "X-Codex-Beta-Features": "one",
          "x-delete-me": null,
          "x-other": "preserved",
        },
        {
          "x-codex-beta-features": "provider_feature,REMOTE_COMPACTION_V2",
          "x-provider-only": "owned-by-provider",
        }
      ),
      ordinaryHeaders,
      routeDecisions: [
        isSupportedLifecycleModel(SPIKE_MODEL),
        isSupportedLifecycleModel({
          ...SPIKE_MODEL,
          provider: "openai",
        }),
        isSupportedLifecycleModel({
          ...SPIKE_MODEL,
          api: "openai-responses",
        }),
      ],
    }).toStrictEqual({
      authDecisions: [true, false, false],
      headers: {
        "X-Codex-Beta-Features": "one,provider_feature,REMOTE_COMPACTION_V2",
        "x-delete-me": null,
        "x-other": "preserved",
      },
      ordinaryHeaders: {
        "X-Codex-Beta-Features": "one,two,remote_compaction_v2",
        "x-codex-beta-features": null,
        "x-delete-me": null,
        "x-other": "preserved",
      },
      routeDecisions: [true, false, false],
    });
  });

  it("validates finalized envelopes and compaction decisions without stale usage", () => {
    const validPayload = {
      input: [userInput("payload")],
      model: SPIKE_MODEL.id,
      store: false,
      stream: true,
    };
    const usage = {
      cacheRead: 2,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        total: 0,
      },
      input: 10,
      output: 3,
      totalTokens: 13,
    };
    const staleAssistant = entry("stale-assistant", {
      message: {
        api: SPIKE_MODEL.api,
        content: [{ text: "stale", type: "text" }],
        model: SPIKE_MODEL.id,
        provider: SPIKE_MODEL.provider,
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage,
      },
      type: "message",
    });
    const boundary = entry(
      "inline-boundary",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: {},
        type: "custom",
      },
      "stale-assistant"
    );
    const freshAssistant = entry(
      "fresh-assistant",
      {
        message: {
          ...(staleAssistant.type === "message" ? staleAssistant.message : {}),
          content: [{ text: "fresh", type: "text" }],
          timestamp: 2,
        },
        type: "message",
      },
      "inline-boundary"
    );
    const trailingUser = entry(
      "trailing-user",
      {
        message: {
          content: "pending prompt",
          role: "user",
          timestamp: 3,
        },
        type: "message",
      },
      "fresh-assistant"
    );
    const failedAssistant = entry(
      "failed-assistant",
      {
        message: {
          ...(freshAssistant.type === "message" ? freshAssistant.message : {}),
          stopReason: "error",
          timestamp: 3,
        },
        type: "message",
      },
      "fresh-assistant"
    );

    expect({
      decisions: [
        shouldCompactFinalizedInput({
          contextWindow: 1000,
          estimatedTokens: 899,
        }),
        shouldCompactFinalizedInput({
          contextWindow: 1000,
          estimatedTokens: 900,
        }),
        shouldCompactFinalizedInput({
          contextWindow: 1000,
          estimatedTokens: 800,
          freshUsageTokens: 899,
        }),
        shouldCompactFinalizedInput({
          contextWindow: 1000,
          estimatedTokens: 800,
          freshUsageTokens: 900,
        }),
        shouldCompactFinalizedInput({
          contextWindow: 1000,
          estimatedTokens: 800,
          freshUsageTokens: 951,
        }),
        shouldCompactFinalizedInput({
          contextWindow: 1000,
          estimatedTokens: 951,
          unchangedReplacement: true,
        }),
      ],
      envelopeDecisions: [
        Boolean(parseFinalizedResponsesEnvelope(validPayload, SPIKE_MODEL)),
        Boolean(
          parseFinalizedResponsesEnvelope(
            { ...validPayload, model: "other" },
            SPIKE_MODEL
          )
        ),
        Boolean(
          parseFinalizedResponsesEnvelope(
            {
              ...validPayload,
              input: [{ type: "compaction_trigger" }],
            },
            SPIKE_MODEL
          )
        ),
        Boolean(
          parseFinalizedResponsesEnvelope(
            { ...validPayload, store: true },
            SPIKE_MODEL
          )
        ),
      ],
      freshUsage: freshAssistantUsageTokens(
        [staleAssistant, boundary, freshAssistant, trailingUser],
        1,
        SPIKE_MODEL
      ),
      retryUsage: freshAssistantUsageTokens(
        [
          staleAssistant,
          boundary,
          freshAssistant,
          failedAssistant,
          trailingUser,
        ],
        1,
        SPIKE_MODEL
      ),
      staleUsage: freshAssistantUsageTokens(
        [staleAssistant, boundary],
        1,
        SPIKE_MODEL
      ),
    }).toStrictEqual({
      decisions: [false, true, false, true, true, false],
      envelopeDecisions: [true, false, false, false],
      freshUsage: 13,
      retryUsage: undefined,
      staleUsage: undefined,
    });
  });

  it("verifies an inline append against leaf, response, and replacement identity", () => {
    const execution = {
      compaction: {
        encrypted_content: "opaque-inline",
        id: "cmp_inline",
        type: "compaction",
      },
      estimatedSourceTokens: 20,
      ok: true,
      responseId: "resp_inline",
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 20,
        output: 2,
        totalTokens: 22,
      },
    } satisfies LifecycleExecutionSuccess;
    const checkpoint = buildLifecycleCheckpoint({
      execution,
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "threshold",
      retainedUsers: [userInput("retained")],
    });
    const previous = entry("previous", {
      message: {
        content: "previous",
        role: "user",
        timestamp: 1,
      },
      type: "message",
    });
    const inline = entry(
      "inline",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: checkpoint,
        type: "custom",
      },
      "previous"
    );
    const tail = entry(
      "tail-after-inline",
      {
        message: {
          content: "tail",
          role: "user",
          timestamp: 2,
        },
        type: "message",
      },
      "inline"
    );

    expect([
      isInlineInstallationResolvable(
        [previous, inline],
        "previous",
        checkpoint.response.id,
        checkpoint.replacementSha256
      ),
      isInlineInstallationResolvable(
        [previous, inline],
        "wrong-parent",
        checkpoint.response.id,
        checkpoint.replacementSha256
      ),
      isInlineInstallationResolvable(
        [previous, inline, tail],
        "previous",
        checkpoint.response.id,
        checkpoint.replacementSha256
      ),
    ]).toStrictEqual([true, false, false]);
  });
});

describe("redacted lifecycle diagnostics", () => {
  it("identifies a context mismatch without retaining message content", () => {
    const sharedPrefix = {
      content: "shared-prefix",
      role: "user" as const,
      timestamp: 1,
    };
    const sharedSuffix = {
      content: "shared-suffix",
      role: "user" as const,
      timestamp: 3,
    };
    const diagnostic = buildContextFrameDiagnostic({
      baseline: [
        sharedPrefix,
        {
          content: "BASELINE_SECRET",
          role: "user",
          timestamp: 2,
        },
        sharedSuffix,
      ],
      boundaryEntryId: "checkpoint-entry",
      branchSha256: "branch-hash",
      eventMessages: [
        sharedPrefix,
        {
          content: "EVENT_SECRET",
          role: "user",
          timestamp: 2,
        },
        sharedSuffix,
      ],
      frameResult: "missing",
      framedSegment: [sharedSuffix],
    });

    expect({
      baselineCount: diagnostic.baseline.messageCount,
      commonPrefix: diagnostic.commonPrefixMessages,
      commonSuffix: diagnostic.commonSuffixMessages,
      eventCount: diagnostic.event.messageCount,
      frameResult: diagnostic.frameResult,
      mismatchContentTypes: diagnostic.event.mismatch?.contentTypes,
      serialized: JSON.stringify(diagnostic),
    }).toMatchObject({
      baselineCount: 3,
      commonPrefix: 1,
      commonSuffix: 1,
      eventCount: 3,
      frameResult: "missing",
      mismatchContentTypes: ["string"],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /BASELINE_SECRET|EVENT_SECRET/u
    );
  });
});
