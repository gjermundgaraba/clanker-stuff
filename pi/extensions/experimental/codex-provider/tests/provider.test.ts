import { zstdDecompressSync } from "node:zlib";

import type { Context, Credential } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { codexContractFixture } from "../../subagents/docs/fixtures/codex-contract.generated.js";
import { REMOTE_USER_IMAGE_PLACEHOLDER } from "../checkpoint.js";
import { CodeModeRuntime } from "../code-mode/tools.js";
import { createCodexModelCatalog } from "../model-catalog.js";
import { CodexObservability } from "../observability.js";
import {
  createCodexProviderRuntime as createProviderRuntime,
  isCodexCompactionCurrentModelFallbackError,
} from "../provider.js";
import {
  responseEvents,
  SPIKE_API_KEY,
  SPIKE_MODEL,
  sse,
  wireRecord,
  wireRecords,
  wireString,
} from "./fixtures.js";
import type { WireRecord, WireValue } from "./fixtures.js";

const StringValueSchema = Type.String();
const HeadersInitSchema = Type.Object({
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const mockSocket = (readyState = 1) =>
  Object.assign(new EventTarget(), {
    close() {},
    readyState,
    send(_data: string) {},
  });

const assistantMessage = (message: Context["messages"][number]) => {
  if (message.role !== "assistant") {
    throw new TypeError("Expected an assistant message");
  }
  return message;
};

const defaultObservability = new CodexObservability(":memory:");
const createCodexProviderRuntime = (
  observability = defaultObservability,
  isFastModeEnabled: () => boolean = () => false,
) => createProviderRuntime(observability, isFastModeEnabled);
const expectedFallbackMultiAgentVersions = codexContractFixture.catalog.declarations;

const interruptedSse = (firstEvent: WireValue) => {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(firstEvent)}\n\n`);
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        controller.error(new Error("SSE interrupted after output"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

const incompleteResponseEvents = (id: string, text: string) => {
  const events = responseEvents(id, text);
  const terminal = events.at(-1);
  if (!terminal || !("response" in terminal)) {
    throw new Error("Response fixture has no terminal event");
  }
  return [
    ...events.slice(0, -1),
    {
      ...terminal,
      response: {
        ...terminal.response,
        incomplete_details: { reason: "max_output_tokens" },
        status: "incomplete",
      },
      type: "response.incomplete",
    },
  ];
};

const compactionEvents = (id: string, serviceTier?: string) => [
  { response: { id, status: "in_progress" }, type: "response.created" },
  {
    item: {
      encrypted_content: `opaque-${id}`,
      metadata: { provider_only: true },
      type: "compaction",
    },
    output_index: 0,
    type: "response.output_item.done",
  },
  {
    response: {
      id,
      output: [],
      service_tier: serviceTier,
      status: "completed",
      usage: {
        input_tokens: 8,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2,
        total_tokens: 10,
      },
    },
    type: "response.done",
  },
];

const context = (messages: Context["messages"]): Context => ({
  messages,
  systemPrompt: "System truth",
});

const CODE_MODE_TOOLS: NonNullable<Context["tools"]> = new CodeModeRuntime().createTools();

const readBody = (body: RequestInit["body"]) => {
  if (Value.Check(StringValueSchema, body)) {
    return wireRecord(JSON.parse(body));
  }
  if (body instanceof Uint8Array) {
    return wireRecord(JSON.parse(zstdDecompressSync(body).toString("utf-8")));
  }
  throw new Error("Unexpected request body");
};

const requestKind = (frame: WireRecord) => {
  const metadata = wireRecord(frame.client_metadata);
  const turn = wireRecord(JSON.parse(wireString(metadata["x-codex-turn-metadata"])));
  return wireString(turn.request_kind);
};

const markProtocolRetryPayload = (payload: WireValue) => ({
  ...wireRecord(payload),
  protocolRetryTest: true,
});

const FAST_MODEL = {
  ...SPIKE_MODEL,
  cost: { cacheRead: 0, cacheWrite: 0, input: 1, output: 2 },
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
};

const encodeJwtPart = (value: WireValue): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const apiKeyForAccount = (accountId: string): string =>
  `${encodeJwtPart({ alg: "none", typ: "JWT" })}.${encodeJwtPart({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;

type ProviderRuntime = ReturnType<typeof createCodexProviderRuntime>;
type RefreshContext = Parameters<NonNullable<ProviderRuntime["provider"]["refreshModels"]>>[0];
type StoredModels = NonNullable<RefreshContext["stored"]>;
interface FetchCatalogState {
  stored?: StoredModels;
}
const publishModelUpdate: RefreshContext["publish"] = async (publication) => {
  publication.update?.();
  return true;
};

const REMOTE_CATALOG = {
  models: [
    {
      auto_compact_token_limit: 150_000,
      comp_hash: "comp-a",
      context_window: 200_000,
      default_reasoning_level: "medium",
      default_reasoning_summary: "concise",
      display_name: "Remote Codex",
      effective_context_window_percent: 95,
      multi_agent_version: "v2",
      priority: 1,
      service_tiers: [{ id: "priority" }],
      slug: "gpt-5.6-remote",
      support_verbosity: true,
      supported_in_api: true,
      supported_reasoning_levels: [
        { description: "Balanced", effort: "medium" },
        { description: "Maximum", effort: "max" },
        { description: "Deepest", effort: "ultra" },
        { description: "Future", effort: "future" },
      ],
      supports_parallel_tool_calls: true,
      supports_reasoning_summary_parameter: true,
      truncation_policy: { limit: 24_000, mode: "bytes" },
      use_responses_lite: true,
      visibility: "list",
    },
    {
      auto_compact_token_limit: null,
      comp_hash: "comp-null-limit",
      context_window: 272_000,
      default_reasoning_level: "ultra",
      display_name: "Application Preset Only",
      priority: 2,
      slug: SPIKE_MODEL.id,
      support_verbosity: true,
      supported_in_api: true,
      supported_reasoning_levels: [{ description: "Application Ultra", effort: "ultra" }],
      supports_parallel_tool_calls: true,
      visibility: "list",
    },
    {
      display_name: "Sol",
      multi_agent_version: null,
      priority: 3,
      slug: "gpt-5.6-sol",
      support_verbosity: true,
      supported_in_api: true,
      supports_parallel_tool_calls: true,
      visibility: "list",
    },
    {
      display_name: "Terra",
      multi_agent_version: "v3",
      priority: 4,
      slug: "gpt-5.6-terra",
      support_verbosity: true,
      supported_in_api: true,
      supports_parallel_tool_calls: true,
      visibility: "list",
    },
    {
      display_name: "Luna",
      priority: 5,
      slug: "gpt-5.6-luna",
      support_verbosity: true,
      supported_in_api: true,
      supports_parallel_tool_calls: true,
      visibility: "list",
    },
    {
      display_name: "Unsupported GPT-5.5",
      priority: 6,
      slug: "gpt-5.5",
      support_verbosity: true,
      supported_in_api: true,
      supports_parallel_tool_calls: true,
      visibility: "list",
    },
  ],
};

const fetchRemoteCatalog = async () => {
  const runtime = createCodexProviderRuntime();
  const requests: Request[] = [];
  const state: FetchCatalogState = {};
  const publish: RefreshContext["publish"] = async (publication) => {
    if (publication.persist === null) {
      delete state.stored;
    } else if (publication.persist !== undefined) {
      state.stored = structuredClone(publication.persist);
    }
    publication.update?.();
    return true;
  };
  const { signal } = new AbortController();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return requests.length === 1
      ? Response.json(REMOTE_CATALOG, {
          headers: { etag: '"catalog-1"' },
        })
      : new Response(null, { status: 304 });
  });
  await runtime.provider.refreshModels?.({
    allowNetwork: true,
    credential: { key: SPIKE_API_KEY, type: "api_key" },
    publish,
    signal,
  });
  const getStored = (): StoredModels => {
    if (state.stored === undefined) {
      throw new Error("Remote model catalog was not persisted");
    }
    return state.stored;
  };
  return { getStored, publish, requests, runtime, signal };
};

const restoreCatalog = async (stored: StoredModels): Promise<ProviderRuntime> => {
  const runtime = createCodexProviderRuntime();
  await runtime.provider.refreshModels?.({
    allowNetwork: false,
    credential: { key: SPIKE_API_KEY, type: "api_key" },
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    signal: new AbortController().signal,
    stored,
  });
  return runtime;
};

describe("Codex provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    defaultObservability.close();
  });

  it("exposes, filters, and executes only GPT-5.6 models", async () => {
    const runtime = createCodexProviderRuntime();
    const unsupportedModel = {
      ...SPIKE_MODEL,
      id: "gpt-5.5",
      name: "GPT-5.5",
    };
    const filtered = runtime.provider.filterModels?.([SPIKE_MODEL, unsupportedModel], {
      key: SPIKE_API_KEY,
      type: "api_key",
    });
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("unsupported", "unexpected")),
    );
    vi.stubGlobal("fetch", fetch);
    const message = await runtime.provider
      .streamSimple(unsupportedModel, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "session-unsupported-model",
        transport: "sse",
      })
      .result();
    await expect(
      runtime.compact({
        apiKey: SPIKE_API_KEY,
        context: context([]),
        effectiveTokenLimit: 1000,
        inputPrefix: [],
        model: unsupportedModel,
        phase: "standalone",
        reason: "manual",
        sessionId: "session-unsupported-compaction",
        signal: new AbortController().signal,
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow("Codex provider supports only GPT-5.6 models: gpt-5.5");

    const listedModels = runtime.provider.getModels();
    expect({
      filtered: filtered?.map((model) => model.id),
      listed: listedModels.map((model) => model.id),
      versions: Object.fromEntries(
        listedModels.map((model) => [
          model.id,
          "multiAgentVersion" in model ? model.multiAgentVersion : undefined,
        ]),
      ),
    }).toStrictEqual({
      filtered: [SPIKE_MODEL.id],
      listed: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      versions: expectedFallbackMultiAgentVersions,
    });
    expect(message).toMatchObject({
      errorMessage: "Codex provider supports only GPT-5.6 models: gpt-5.5",
      stopReason: "error",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      errorMessage: 'Unsupported Codex Responses reasoning effort: "ultra"',
      label: "non-wire effort",
      reasoning: { effort: "ultra" },
    },
    {
      errorMessage: "Codex payload reasoning must be an object",
      label: "null reasoning",
      reasoning: null,
    },
    {
      errorMessage: "Unsupported Codex Responses reasoning effort: null",
      label: "null effort",
      reasoning: { effort: null },
    },
  ])("rejects $label injected by a payload transform", async ({ errorMessage, reasoning }) => {
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("invalid-transformed-effort", "unexpected")),
    );
    const message = await createCodexProviderRuntime()
      .provider.streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        onPayload: (payload) => ({
          ...wireRecord(payload),
          reasoning,
        }),
        sessionId: "session-invalid-transformed-effort",
        transport: "sse",
      })
      .result();

    expect(message).toMatchObject({ errorMessage, stopReason: "error" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves Pi callbacks and builds a complete SSE request", async () => {
    const runtime = createCodexProviderRuntime();
    const payloads: WireValue[] = [];
    const requests: RequestInit[] = [];
    const responses: number[] = [];
    const message = await runtime.provider
      .streamSimple(
        {
          ...SPIKE_MODEL,
          compat: { supportsOpenAIGrammarTools: true },
          input: ["text", "image"],
        },
        {
          ...context([
            {
              content: [
                {
                  data: "AA==",
                  mimeType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
              timestamp: 1,
            },
          ]),
          tools: CODE_MODE_TOOLS,
        },
        {
          apiKey: SPIKE_API_KEY,
          fetch: async (_input, init) => {
            requests.push(init ?? {});
            return sse(responseEvents("resp_sse", "hello back", false));
          },
          onPayload: (payload) => {
            payloads.push(payload);
          },
          onResponse: ({ status }) => {
            responses.push(status);
          },
          sessionId: "session-sse",
          transport: "sse",
        },
      )
      .result();

    const body = readBody(requests[0]?.body);
    const [standardMessage] = wireRecords(body.input);
    const [standardImage] = wireRecords(standardMessage?.content);
    const clientMetadata = wireRecord(body.client_metadata);
    expect({
      callbackCounts: [payloads.length, responses.length],
      clientMetadata: JSON.parse(wireString(clientMetadata["x-codex-turn-metadata"])),
      diagnostics: message.diagnostics,
      endTurn: message.endTurn,
      header: new Headers(requests[0]?.headers).get("x-openai-internal-codex-responses-lite"),
      instructions: body.instructions,
      output: message.content,
      requestCount: requests.length,
      standardImage,
      store: body.store,
      tools: wireRecords(body.tools).map(({ name, type }) => ({
        name,
        type,
      })),
    }).toMatchObject({
      callbackCounts: [1, 1],
      clientMetadata: {
        request_kind: "turn",
        session_id: "session-sse",
        thread_id: "session-sse",
      },
      diagnostics: undefined,
      endTurn: false,
      header: null,
      instructions: "System truth",
      output: [{ text: "hello back", type: "text" }],
      requestCount: 1,
      standardImage: {
        detail: "auto",
        image_url: "data:image/png;base64,AA==",
        type: "input_image",
      },
      store: false,
      tools: [
        { name: "exec", type: "custom" },
        { name: "wait", type: "function" },
      ],
    });
    expect(clientMetadata["x-codex-turn-metadata"]).toStrictEqual(expect.any(String));
  });

  it("derives authoritative SSE routing hints from the final request", async () => {
    let fastMode = false;
    const requests: Request[] = [];
    const runtime = createCodexProviderRuntime(defaultObservability, () => fastMode);
    const send = async (sessionId: string) => {
      await runtime.provider
        .streamSimple(FAST_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          fetch: async (input, init) => {
            requests.push(new Request(input, init));
            return sse(responseEvents(`resp_${sessionId}`, "done"));
          },
          headers: {
            originator: "stale",
            "x-codex-routing-hint": "model=stale;tier=stale",
          },
          onPayload: (payload) => ({
            ...wireRecord(payload),
            model: "gpt-5.6-final",
          }),
          sessionId,
          transport: "sse",
        })
        .result();
    };

    await send("routing-standard");
    fastMode = true;
    await send("routing-fast");

    expect(
      requests.map((request) => ({
        originator: request.headers.get("originator"),
        routingHint: request.headers.get("x-codex-routing-hint"),
      })),
    ).toStrictEqual([
      { originator: "pi", routingHint: "model=gpt-5.6-final" },
      {
        originator: "codex_cli_rs",
        routingHint: "model=gpt-5.6-final;tier=priority",
      },
    ]);
  });

  it("places deferred tools using the model's supported mode", async () => {
    const toolCallId = "call_base|fc_base";
    const dynamicContext: Context = {
      ...context([
        {
          ...fauxAssistantMessage(fauxToolCall("exec", {}, { id: toolCallId }), {
            stopReason: "toolUse",
            timestamp: 1,
          }),
          api: SPIKE_MODEL.api,
          model: SPIKE_MODEL.id,
          provider: SPIKE_MODEL.provider,
        },
        {
          addedToolNames: ["wait"],
          content: [{ text: "loaded", type: "text" }],
          isError: false,
          role: "toolResult",
          timestamp: 2,
          toolCallId,
          toolName: "exec",
        },
      ]),
      tools: CODE_MODE_TOOLS,
    };
    const [additionalTools, toolSearchOnly] = await Promise.all(
      [
        { supportsAdditionalTools: true, supportsToolSearch: true },
        { supportsToolSearch: true },
      ].map(async (compat, index) => {
        let body: RequestInit["body"];
        await createCodexProviderRuntime()
          .provider.streamSimple({ ...SPIKE_MODEL, compat }, dynamicContext, {
            apiKey: SPIKE_API_KEY,
            fetch: async (_input, init) => {
              body = init?.body;
              return sse(responseEvents(`resp_deferred_${index}`, "done"));
            },
            sessionId: `session-deferred-${index}`,
            transport: "sse",
          })
          .result();
        return readBody(body);
      }),
    );

    expect(additionalTools).toMatchObject({
      input: [
        { type: "function_call" },
        { type: "function_call_output" },
        { tools: [{ name: "wait" }], type: "additional_tools" },
      ],
      tools: [{ name: "exec" }],
    });
    expect(toolSearchOnly).toMatchObject({
      input: [
        { type: "function_call" },
        { type: "function_call_output" },
        { type: "tool_search_call" },
        { tools: [{ name: "wait" }], type: "tool_search_output" },
      ],
      tools: [{ name: "exec" }],
    });
  });

  it("applies fast mode to turns and compaction with priority pricing", async () => {
    const requests: WireRecord[] = [];
    const runtime = createCodexProviderRuntime(defaultObservability, () => true);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = readBody(init?.body);
      requests.push(body);
      return requestKind(body) === "compaction"
        ? sse(compactionEvents("resp_fast_compaction"))
        : sse(responseEvents("resp_fast_turn", "fast"));
    });

    const compaction = await runtime.compact({
      apiKey: SPIKE_API_KEY,
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: FAST_MODEL,
      phase: "standalone",
      reason: "threshold",
      sessionId: "session-fast",
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    const message = await runtime.provider
      .streamSimple(FAST_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "session-fast",
        transport: "sse",
      })
      .result();

    expect({
      serviceTiers: requests.map((request) => request.service_tier),
      supportsFastMode: runtime.supportsFastMode(FAST_MODEL),
    }).toStrictEqual({
      serviceTiers: ["priority", "priority"],
      supportsFastMode: true,
    });
    expect(compaction.usage.cost.total).toBeCloseTo(2.4e-5, 10);
    expect(message.usage.cost.total).toBeCloseTo(2.4e-5, 10);
  });

  it("snapshots fast mode for turns and inline compaction", async () => {
    let fastMode = false;
    const requests: WireRecord[] = [];
    vi.stubGlobal("WebSocket", null);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = readBody(init?.body);
      requests.push(body);
      return requestKind(body) === "compaction"
        ? sse(compactionEvents("resp_snapshot_compaction"))
        : sse(responseEvents(`resp_snapshot_${requests.length}`, "done"));
    });
    const runtime = createCodexProviderRuntime(defaultObservability, () => fastMode);
    const sessionId = "session-fast-snapshot";

    await runtime.provider
      .streamSimple(FAST_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId,
      })
      .result();
    fastMode = true;
    await runtime.compact({
      apiKey: SPIKE_API_KEY,
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: FAST_MODEL,
      phase: "mid-turn",
      reason: "threshold",
      sessionId,
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    runtime.endTurn(sessionId);
    runtime.beginTurn(sessionId);
    await runtime.provider
      .streamSimple(FAST_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId,
      })
      .result();

    expect(
      requests.map((request) => ({
        kind: requestKind(request),
        tier: request.service_tier,
      })),
    ).toStrictEqual([
      { kind: "turn", tier: undefined },
      { kind: "compaction", tier: undefined },
      { kind: "turn", tier: "priority" },
    ]);
  });

  it("removes priority from transition compaction on an unsupported model", async () => {
    let request: WireRecord | undefined;
    const runtime = createCodexProviderRuntime(defaultObservability, () => true);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      request = readBody(init?.body);
      return sse(compactionEvents("resp_transition_tier"));
    });

    await runtime.compact({
      apiKey: SPIKE_API_KEY,
      authoritativeEnvelope: { service_tier: "priority" },
      codexReason: "model_downshift",
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "threshold",
      sessionId: "session-transition-tier",
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });

    expect(request?.service_tier).toBeUndefined();
  });

  it("prices compaction using the effective response tier", async () => {
    let request: WireRecord | undefined;
    const runtime = createCodexProviderRuntime();
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      request = readBody(init?.body);
      return sse(compactionEvents("resp_effective_tier", "priority"));
    });

    const result = await runtime.compact({
      apiKey: SPIKE_API_KEY,
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: FAST_MODEL,
      phase: "standalone",
      reason: "threshold",
      sessionId: "session-effective-tier",
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });

    expect(request?.service_tier).toBeUndefined();
    expect(result.usage.cost.total).toBeCloseTo(2.4e-5, 10);
  });

  it("does not retry SSE after the first emitted event", async () => {
    const runtime = createCodexProviderRuntime();
    let attempts = 0;
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? interruptedSse({
                response: { id: "resp_partial", status: "in_progress" },
                type: "response.created",
              })
            : sse(responseEvents("resp_retry", "must not be merged"));
        },
        maxRetries: 1,
        sessionId: "session-sse-partial",
        transport: "sse",
      })
      .result();

    expect({
      attempts,
      diagnostics: message.diagnostics,
      error: message.errorMessage,
      stop: message.stopReason,
    }).toStrictEqual({
      attempts: 1,
      diagnostics: undefined,
      error: "SSE interrupted after output",
      stop: "error",
    });
  });

  it("retries generic HTTP 429 responses", async () => {
    let attempts = 0;
    const message = await createCodexProviderRuntime()
      .provider.streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => {
          attempts += 1;
          return Response.json(
            { error: { code: "rate_limit", message: "rate limited" } },
            { status: 429 },
          );
        },
        maxRetries: 2,
        sessionId: "session-generic-429",
        transport: "sse",
      })
      .result();

    expect({
      attempts,
      error: message.errorMessage,
      stop: message.stopReason,
    }).toStrictEqual({
      attempts: 3,
      error: "rate limited",
      stop: "error",
    });
  });

  it("does not retry a server delay beyond the configured bound", async () => {
    let attempts = 0;
    const message = await createCodexProviderRuntime()
      .provider.streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => {
          attempts += 1;
          return Response.json(
            { error: { code: "rate_limit", message: "rate limited" } },
            {
              headers: { "retry-after-ms": "999999" },
              status: 429,
            },
          );
        },
        maxRetries: 2,
        sessionId: "session-retry-delay-bound",
        transport: "sse",
      })
      .result();

    expect(attempts).toBe(1);
    expect(message.errorMessage).toContain("retry delay");
    expect(message.stopReason).toBe("error");
  });

  it("keeps valid error fields when a sibling field is malformed", async () => {
    const message = await createCodexProviderRuntime()
      .provider.streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () =>
          sse([
            {
              error: { code: null, message: "quota", status: 429 },
              type: "error",
            },
          ]),
        maxRetries: 0,
        sessionId: "session-partial-error",
        transport: "sse",
      })
      .result();

    expect(message.errorMessage).toBe("quota");
  });

  it("returns incomplete responses as length stops", async () => {
    const runtime = createCodexProviderRuntime();
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => sse(incompleteResponseEvents("resp_incomplete", "partial answer")),
        sessionId: "session-incomplete-response",
        transport: "sse",
      })
      .result();

    expect({
      content: message.content,
      error: message.errorMessage,
      responseId: message.responseId,
      stop: message.stopReason,
    }).toMatchObject({
      content: [{ text: "partial answer", type: "text" }],
      error: undefined,
      responseId: "resp_incomplete",
      stop: "length",
    });
  });

  it("keeps inline compaction on the active SSE transport", async () => {
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const requests: RequestInit[] = [];
    const websocket = vi.fn<() => never>(() => {
      throw new Error("unexpected WebSocket attempt");
    });
    vi.stubGlobal("WebSocket", websocket);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return requestKind(readBody(init?.body)) === "compaction"
        ? sse(compactionEvents("resp_inline_compact"))
        : sse(responseEvents("resp_after_compact", "done"));
    });

    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        onPayload: async () => {
          await runtime.compact({
            apiKey: SPIKE_API_KEY,
            authoritativeInput: [],
            context: context([]),
            effectiveTokenLimit: 1000,
            inputPrefix: [],
            model: SPIKE_MODEL,
            phase: "pre-sampling",
            reason: "threshold",
            sessionId: "session-inline-sse",
            signal: new AbortController().signal,
            thinkingLevel: "medium",
          });
        },
        sessionId: "session-inline-sse",
        transport: "sse",
      })
      .result();

    expect({
      compaction: observability
        .list("session-inline-sse")
        .find((observation) => observation.kind === "compaction")?.data,
      requestKinds: requests.map((request) => requestKind(readBody(request.body))),
      websocketAttempts: websocket.mock.calls.length,
    }).toStrictEqual({
      compaction: expect.objectContaining({
        attempts: 1,
        outcome: "success",
        transport: expect.objectContaining({ transportUsed: "sse" }),
      }),
      requestKinds: ["compaction", "turn"],
      websocketAttempts: 0,
    });
    observability.close();
  });

  it("isolates inline compaction transport across overlapping requests", async () => {
    const runtime = createCodexProviderRuntime();
    const firstEntered = Promise.withResolvers<null>();
    const secondEntered = Promise.withResolvers<null>();
    const releaseSecond = Promise.withResolvers<null>();
    const websocket = vi.fn<() => never>(() => {
      throw new Error("unexpected WebSocket attempt");
    });
    vi.stubGlobal("WebSocket", websocket);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) =>
      requestKind(readBody(init?.body)) === "compaction"
        ? sse(compactionEvents("resp_isolated_compact"))
        : sse(responseEvents("resp_isolated_turn", "done")),
    );

    const first = runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        onPayload: async () => {
          firstEntered.resolve(null);
          await secondEntered.promise;
          await runtime.compact({
            apiKey: SPIKE_API_KEY,
            authoritativeInput: [],
            context: context([]),
            effectiveTokenLimit: 1000,
            inputPrefix: [],
            model: SPIKE_MODEL,
            phase: "pre-sampling",
            reason: "threshold",
            sessionId: "session-overlap-transport",
            signal: new AbortController().signal,
            thinkingLevel: "medium",
          });
        },
        sessionId: "session-overlap-transport",
        transport: "sse",
      })
      .result();
    await firstEntered.promise;

    const second = runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        onPayload: async () => {
          secondEntered.resolve(null);
          await releaseSecond.promise;
          throw new Error("stop overlapping request");
        },
        sessionId: "session-overlap-transport",
        transport: "auto",
      })
      .result();

    await expect(first).resolves.toMatchObject({ stopReason: "stop" });
    releaseSecond.resolve(null);
    await expect(second).resolves.toMatchObject({ stopReason: "error" });
    expect(websocket).not.toHaveBeenCalled();
  });

  it("restores authoritative remote model lists and selectors offline", async () => {
    const { getStored, publish, requests, runtime, signal } = await fetchRemoteCatalog();

    await runtime.provider.refreshModels?.({
      allowNetwork: false,
      credential: { key: SPIKE_API_KEY, type: "api_key" },
      publish,
      signal,
      stored: getStored(),
    });
    await runtime.provider.refreshModels?.({
      allowNetwork: true,
      credential: { key: SPIKE_API_KEY, type: "api_key" } satisfies Credential,
      force: true,
      publish,
      signal,
      stored: getStored(),
    });

    const persistedRemoteAfterNotModified = getStored().models.some(
      (model) => model.id === "gpt-5.6-remote",
    );
    const stored = getStored();
    const restored = await restoreCatalog(stored);
    const omitted = await restoreCatalog({
      ...stored,
      models: stored.models.filter((model) => model.id !== "gpt-5.6-luna"),
    });
    const invalid = await restoreCatalog({
      ...stored,
      models: stored.models.map((model) => {
        const withoutVersion = { ...model };
        Reflect.deleteProperty(withoutVersion, "codexProviderCacheVersion");
        return model.id === "gpt-5.6-sol"
          ? { ...withoutVersion, multiAgentVersion: "v1" as const }
          : withoutVersion;
      }),
    });
    const versionPresence = Object.fromEntries(
      restored.provider
        .getModels()
        .filter((model) => ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(model.id))
        .map((model) => [model.id, "multiAgentVersion" in model]),
    );
    const invalidSol = invalid.provider.getModels().find((model) => model.id === "gpt-5.6-sol");
    const restoredSol = restored.provider.getModels().find((model) => model.id === "gpt-5.6-sol");

    expect({
      invalidCacheSolVersion:
        invalidSol !== undefined && "multiAgentVersion" in invalidSol
          ? invalidSol.multiAgentVersion
          : undefined,
      liveCatalog: runtime.provider.getModels().map((model) => model.id),
      liveRemoteAfterRepeatedRestore: runtime.provider
        .getModels()
        .some((model) => model.id === "gpt-5.6-remote"),
      omittedLunaRestored: omitted.provider
        .getModels()
        .some((model) => model.id === "gpt-5.6-luna"),
      persistedRemoteAfterNotModified,
      refreshRequests: requests.length,
      request: requests[0]?.url,
      restoredFallbackVersion:
        restoredSol !== undefined && "multiAgentVersion" in restoredSol
          ? restoredSol.multiAgentVersion
          : undefined,
      restoredRemoteCatalog: restored.provider
        .getModels()
        .some((model) => model.id === "gpt-5.6-remote"),
      routingHint: requests[0]?.headers.get("x-codex-routing-hint"),
      versionPresence,
    }).toStrictEqual({
      invalidCacheSolVersion: "v2",
      liveCatalog: [
        "gpt-5.6-remote",
        SPIKE_MODEL.id,
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ],
      liveRemoteAfterRepeatedRestore: true,
      omittedLunaRestored: false,
      persistedRemoteAfterNotModified: true,
      refreshRequests: 2,
      request: expect.stringContaining("/codex/models?client_version="),
      restoredFallbackVersion: undefined,
      restoredRemoteCatalog: true,
      routingHint: null,
      versionPresence: {
        "gpt-5.6-luna": false,
        "gpt-5.6-sol": false,
        "gpt-5.6-terra": false,
      },
    });
  });

  it("does not restore or retain another account's cached catalog", async () => {
    const { getStored, publish, runtime, signal } = await fetchRemoteCatalog();
    expect(
      runtime.provider.getModels().some((model) => model.id === "gpt-5.6-remote"),
    ).toBeTruthy();

    await runtime.provider.refreshModels?.({
      allowNetwork: false,
      credential: {
        key: apiKeyForAccount("different-account"),
        type: "api_key",
      },
      publish,
      signal,
      stored: getStored(),
    });

    expect({
      hasRemoteModel: runtime.provider.getModels().some((model) => model.id === "gpt-5.6-remote"),
      remoteMetadata: runtime.getModelMetadata("gpt-5.6-remote"),
    }).toStrictEqual({
      hasRemoteModel: false,
      remoteMetadata: undefined,
    });
  });

  it("bypasses the model cache when the Codex account changes", async () => {
    let stored: RefreshContext["stored"];
    const publish: RefreshContext["publish"] = async (publication) => {
      stored = publication.persist ?? undefined;
      publication.update?.();
      return true;
    };
    const accountChanged = vi.fn<() => void>();
    const catalog = createCodexModelCatalog(accountChanged);
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(REMOTE_CATALOG, {
        headers: { etag: '"catalog-1"' },
      });
    });
    const refresh = async (key: string) =>
      catalog.refreshModels({
        allowNetwork: true,
        credential: { key, type: "api_key" },
        publish,
        signal: new AbortController().signal,
        stored,
      });

    await refresh(SPIKE_API_KEY);
    await refresh(apiKeyForAccount("phase-one-account"));

    expect(accountChanged).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("chatgpt-account-id")).toBe("phase-one-account");
    expect(requests[1]?.headers.has("if-none-match")).toBeFalsy();
  });

  it("announces Codex account changes while refreshing the catalog", async () => {
    const accountChanged = vi.fn<() => void>();
    const runtime = createProviderRuntime(
      defaultObservability,
      () => false,
      createCodexModelCatalog(accountChanged),
    );
    const { signal } = new AbortController();

    await runtime.provider.refreshModels?.({
      allowNetwork: false,
      credential: {
        key: apiKeyForAccount("first-account"),
        type: "api_key",
      },
      publish: publishModelUpdate,
      signal,
    });
    await runtime.provider.refreshModels?.({
      allowNetwork: false,
      credential: {
        key: apiKeyForAccount("second-account"),
        type: "api_key",
      },
      publish: publishModelUpdate,
      signal,
    });

    expect(accountChanged).toHaveBeenCalledOnce();
  });

  it("projects remote reasoning, fast-mode, and context-window metadata", async () => {
    const { runtime } = await fetchRemoteCatalog();
    const [remoteModel] = runtime.provider.getModels();
    if (!remoteModel) {
      throw new Error("Remote model was not projected");
    }

    expect({
      metadata: runtime.getModelMetadata(remoteModel.id)?.comp_hash,
      model: remoteModel,
      supportsFastMode: runtime.supportsFastMode(remoteModel),
      unsupportedMetadata: runtime.getModelMetadata("gpt-5.5"),
      window: runtime.getModelWindow(remoteModel),
    }).toMatchObject({
      metadata: "comp-a",
      model: {
        codexOutputTokenLimit: 6000,
        contextWindow: 200_000,
        id: "gpt-5.6-remote",
        multiAgentVersion: "v2",
      },
      supportsFastMode: true,
      unsupportedMetadata: undefined,
      window: {
        autoCompactTokens: 150_000,
        effectiveWindowTokens: 190_000,
      },
    });
    expect(remoteModel.thinkingLevelMap).toStrictEqual({
      high: null,
      low: null,
      max: "max",
      medium: "medium",
      minimal: null,
      off: null,
      xhigh: null,
    });

    const nullLimitModel = runtime.provider
      .getModels()
      .find((model) => model.id === SPIKE_MODEL.id);
    if (!nullLimitModel) {
      throw new Error("Null-limit model was not projected");
    }
    expect({
      reasoning: nullLimitModel.reasoning,
      thinkingLevelMap: nullLimitModel.thinkingLevelMap,
      window: runtime.getModelWindow(nullLimitModel),
    }).toStrictEqual({
      reasoning: false,
      thinkingLevelMap: {
        high: null,
        low: null,
        max: null,
        medium: null,
        minimal: null,
        off: null,
        xhigh: null,
      },
      window: {
        autoCompactTokens: 244_800,
        effectiveWindowTokens: 258_400,
      },
    });
    const defaultRequests: RequestInit[] = [];
    await runtime.provider
      .streamSimple(nullLimitModel, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async (_input, init) => {
          defaultRequests.push(init ?? {});
          return sse(responseEvents("unsupported-default", "accepted"));
        },
        sessionId: "session-unsupported-default",
        transport: "sse",
      })
      .result();
    expect(readBody(defaultRequests[0]?.body).reasoning).toBeUndefined();
  });

  it("restores Responses Lite request behavior from cached metadata", async () => {
    const { getStored } = await fetchRemoteCatalog();
    const runtime = await restoreCatalog(getStored());
    const [projected] = runtime.provider.getModels();
    if (!projected) {
      throw new Error("Cached remote model was not restored");
    }
    const outputTokenLimit =
      "codexOutputTokenLimit" in projected ? projected.codexOutputTokenLimit : undefined;
    const remoteModel = {
      ...projected,
      compat: { supportsOpenAIGrammarTools: true },
      input: ["text", "image"],
    } satisfies typeof projected;
    expect({
      metadata: runtime.getModelMetadata(remoteModel.id)?.comp_hash,
      outputTokenLimit,
      supportsFastMode: runtime.supportsFastMode(remoteModel),
      window: runtime.getModelWindow(remoteModel),
    }).toStrictEqual({
      metadata: "comp-a",
      outputTokenLimit: 6000,
      supportsFastMode: true,
      window: {
        autoCompactTokens: 150_000,
        effectiveWindowTokens: 190_000,
      },
    });

    const liteRequests: RequestInit[] = [];
    await runtime.provider
      .streamSimple(
        remoteModel,
        {
          ...context([
            {
              content: [
                {
                  data: "AA==",
                  mimeType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
              timestamp: 1,
            },
          ]),
          tools: CODE_MODE_TOOLS,
        },
        {
          apiKey: SPIKE_API_KEY,
          fetch: async (_input, init) => {
            liteRequests.push(init ?? {});
            return sse(responseEvents("resp_lite", "lite"));
          },
          sessionId: "session-lite",
          transport: "sse",
        },
      )
      .result();
    const liteBody = readBody(liteRequests[0]?.body);
    const liteHeaders = new Headers(liteRequests[0]?.headers);
    const liteInput = wireRecords(liteBody.input);
    const [litePrefix] = liteInput;
    if (!litePrefix) {
      throw new Error("Responses Lite prefix was not serialized");
    }
    const liteMessage = liteInput.at(2);
    const [liteImage] = wireRecords(liteMessage?.content);
    expect({
      additionalTools: wireRecords(litePrefix.tools).map(({ name, type }) => ({
        name,
        type,
      })),
      bodyTools: liteBody.tools,
      header: liteHeaders.get("x-openai-internal-codex-responses-lite"),
      instructions: liteBody.instructions,
      liteImage,
      prefix: liteInput.slice(0, 2).map((item) => item.type),
      reasoning: liteBody.reasoning,
    }).toStrictEqual({
      additionalTools: [
        { name: "exec", type: "custom" },
        { name: "wait", type: "function" },
      ],
      bodyTools: undefined,
      header: "true",
      instructions: "",
      liteImage: {
        image_url: "data:image/png;base64,AA==",
        type: "input_image",
      },
      prefix: ["additional_tools", "message"],
      reasoning: {
        context: "all_turns",
        effort: "medium",
        summary: "concise",
      },
    });

    const liteFrames: WireRecord[] = [];
    const LiteWebSocket = function LiteWebSocket() {
      const socket = mockSocket();
      socket.readyState = 1;
      socket.close = () => null;
      socket.send = (data: string) => {
        const frame = wireRecord(JSON.parse(data));
        liteFrames.push(frame);
        const events =
          frame.generate === false
            ? [
                {
                  response: { id: "prewarm", status: "completed" },
                  type: "response.done",
                },
              ]
            : responseEvents("resp_lite_ws", "lite ws");
        for (const event of events) {
          queueMicrotask(() =>
            socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
          );
        }
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", LiteWebSocket);
    runtime.beginTurn("session-lite-ws");
    await runtime.provider
      .streamSimple(
        remoteModel,
        {
          ...context([
            {
              content: [
                {
                  data: "AA==",
                  mimeType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
              timestamp: 1,
            },
          ]),
          tools: CODE_MODE_TOOLS,
        },
        { apiKey: SPIKE_API_KEY, sessionId: "session-lite-ws" },
      )
      .result();
    expect(
      liteFrames.map((frame) => ({
        inputTypes: wireRecords(frame.input).map((item) => item.type ?? item.role),
        previousResponseId: frame.previous_response_id,
      })),
    ).toStrictEqual([
      {
        inputTypes: ["additional_tools", "message"],
        previousResponseId: undefined,
      },
      {
        inputTypes: ["additional_tools", "message", "user"],
        previousResponseId: undefined,
      },
    ]);
  });

  it("omits transformed Responses Lite image URLs with mixed-case HTTP schemes", async () => {
    const { getStored } = await fetchRemoteCatalog();
    const runtime = await restoreCatalog(getStored());
    const [projected] = runtime.provider.getModels();
    if (!projected) {
      throw new Error("Cached remote model was not restored");
    }
    const remoteModel = {
      ...projected,
      input: ["text", "image"],
    } satisfies typeof projected;
    const requests: RequestInit[] = [];
    const remoteImageUrl = "HtTpS://example.invalid/image.png";

    await runtime.provider
      .streamSimple(
        remoteModel,
        context([{ content: "replace with image", role: "user", timestamp: 1 }]),
        {
          apiKey: SPIKE_API_KEY,
          fetch: async (_input, init) => {
            requests.push(init ?? {});
            return sse(responseEvents("resp_lite_mixed_case_image", "lite"));
          },
          onPayload: (payload) => {
            const body = wireRecord(payload);
            return {
              ...body,
              input: wireRecords(body.input).map((item) =>
                item.role === "user"
                  ? {
                      ...item,
                      content: [
                        {
                          detail: "high",
                          image_url: remoteImageUrl,
                          type: "input_image",
                        },
                      ],
                    }
                  : item,
              ),
            };
          },
          sessionId: "session-lite-mixed-case-image",
          transport: "sse",
        },
      )
      .result();

    const body = readBody(requests[0]?.body);
    const userMessage = wireRecords(body.input).find((item) => item.role === "user");
    expect(wireRecords(userMessage?.content)).toStrictEqual([
      {
        text: REMOTE_USER_IMAGE_PLACEHOLDER,
        type: "input_text",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(remoteImageUrl);
  });

  it("reuses sockets by route and sends only exact continuation deltas", async () => {
    const frames: WireRecord[] = [];
    const handshakeHints: string[] = [];
    const socketUrls: string[] = [];
    let closes = 0;
    let fastMode = false;
    let responseNumber = 0;
    class MockWebSocket {
      readonly readyState = 1;
      private readonly listeners = new Map<string, Set<(event: WireValue) => void>>();

      constructor(
        url: string,
        protocols?: string | string[] | { headers?: Record<string, string> },
      ) {
        socketUrls.push(url);
        if (Value.Check(HeadersInitSchema, protocols)) {
          handshakeHints.push(protocols.headers?.["x-codex-routing-hint"] ?? "");
        }
        queueMicrotask(() => this.emit("open", {}));
      }

      addEventListener(type: string, listener: (event: WireValue) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      close() {
        closes += 1;
        this.listeners.clear();
      }

      removeEventListener(type: string, listener: (event: WireValue) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      send(data: string) {
        const frame = wireRecord(JSON.parse(data));
        frames.push(frame);
        responseNumber += 1;
        const id = `resp_ws_${responseNumber}`;
        const events =
          frame.generate === false
            ? [
                {
                  response: {
                    id,
                    output: [],
                    status: "completed",
                    usage: {
                      input_tokens: 0,
                      output_tokens: 0,
                      total_tokens: 0,
                    },
                  },
                  type: "response.done",
                },
              ]
            : [
                ...(responseNumber === 2
                  ? [
                      {
                        headers: { "x-codex-turn-state": "turn-state-1" },
                        type: "response.metadata",
                      },
                    ]
                  : []),
                ...responseEvents(id, `answer ${responseNumber}`, false),
              ];
        for (const event of events) {
          queueMicrotask(() => this.emit("message", { data: JSON.stringify(event) }));
        }
      }

      private emit(type: string, event: WireValue) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    const runtime = createCodexProviderRuntime(defaultObservability, () => fastMode);
    runtime.beginTurn("session-ws");
    const first = await runtime.provider
      .streamSimple(FAST_MODEL, context([{ content: "one", role: "user", timestamp: 1 }]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "session-ws",
      })
      .result();
    const second = await runtime.provider
      .streamSimple(
        FAST_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
        ]),
        { apiKey: SPIKE_API_KEY, sessionId: "session-ws" },
      )
      .result();
    runtime.endTurn("session-ws");
    fastMode = true;
    runtime.beginTurn("session-ws");
    const third = await runtime.provider
      .streamSimple(
        FAST_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
          assistantMessage(second),
          { content: "three", role: "user", timestamp: 3 },
        ]),
        { apiKey: SPIKE_API_KEY, sessionId: "session-ws" },
      )
      .result();
    const fourth = await runtime.provider
      .streamSimple(
        FAST_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
          assistantMessage(second),
          { content: "three", role: "user", timestamp: 3 },
          assistantMessage(third),
          { content: "four", role: "user", timestamp: 4 },
        ]),
        { apiKey: SPIKE_API_KEY, sessionId: "session-ws" },
      )
      .result();
    const otherApiKey = apiKeyForAccount("account-other");
    const fifth = await runtime.provider
      .streamSimple(
        FAST_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
          assistantMessage(second),
          { content: "three", role: "user", timestamp: 3 },
          assistantMessage(third),
          { content: "four", role: "user", timestamp: 4 },
          assistantMessage(fourth),
          { content: "five", role: "user", timestamp: 5 },
        ]),
        { apiKey: otherApiKey, sessionId: "session-ws" },
      )
      .result();
    await runtime.provider
      .streamSimple(
        { ...FAST_MODEL, baseUrl: "https://example.test/backend-api" },
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
          assistantMessage(second),
          { content: "three", role: "user", timestamp: 3 },
          assistantMessage(third),
          { content: "four", role: "user", timestamp: 4 },
          assistantMessage(fourth),
          { content: "five", role: "user", timestamp: 5 },
          assistantMessage(fifth),
          { content: "six", role: "user", timestamp: 6 },
        ]),
        { apiKey: otherApiKey, sessionId: "session-ws" },
      )
      .result();

    const generated = frames.filter((frame) => frame.generate !== false);
    const prewarm = frames.find((frame) => frame.generate === false);
    expect({
      closes,
      endTurns: [first.endTurn, second.endTurn],
      handshakeHints,
      inputLengths: generated.map((frame) => wireRecords(frame.input).length),
      previousResponseIds: generated.map((frame) => frame.previous_response_id),
      prewarmInput: prewarm?.input,
      requestCount: generated.length,
      requestKinds: frames.map(requestKind),
      socketUrls,
      turnStates: generated.map((frame) => wireRecord(frame.client_metadata)["x-codex-turn-state"]),
    }).toStrictEqual({
      closes: 3,
      endTurns: [false, false],
      handshakeHints: [
        `model=${FAST_MODEL.id}`,
        `model=${FAST_MODEL.id};tier=priority`,
        `model=${FAST_MODEL.id};tier=priority`,
        `model=${FAST_MODEL.id};tier=priority`,
      ],
      inputLengths: [1, 1, 5, 1, 9, 11],
      previousResponseIds: [undefined, "resp_ws_2", undefined, "resp_ws_4", undefined, undefined],
      prewarmInput: [],
      requestCount: 6,
      requestKinds: ["prewarm", "turn", "turn", "turn", "turn", "turn", "turn"],
      socketUrls: [
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://example.test/backend-api/codex/responses",
      ],
      turnStates: [undefined, "turn-state-1", undefined, undefined, undefined, undefined],
    });
  });

  it("falls back concurrent same-session work without closing the busy socket", async () => {
    let closes = 0;
    let activeSocket: EventTarget | undefined;
    const requestStarted = Promise.withResolvers<null>();
    const BusyWebSocket = function BusyWebSocket() {
      const socket = mockSocket();
      activeSocket = socket;
      socket.readyState = 1;
      socket.close = () => {
        closes += 1;
      };
      socket.send = (data) => {
        const frame = wireRecord(JSON.parse(data));
        if (frame.generate === false) {
          queueMicrotask(() =>
            socket.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  response: { id: "prewarm", status: "completed" },
                  type: "response.done",
                }),
              }),
            ),
          );
        } else {
          requestStarted.resolve(null);
        }
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", BusyWebSocket);
    const runtime = createCodexProviderRuntime();
    const firstResult = runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "session-concurrent",
      })
      .result();
    await requestStarted.promise;
    const second = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => sse(responseEvents("resp_sse", "second")),
        sessionId: "session-concurrent",
      })
      .result();

    for (const event of responseEvents("resp_ws", "first")) {
      activeSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }
    const first = await firstResult;

    expect({
      closes,
      contents: [first, second].map((message) =>
        message.content.map((block) => ("text" in block ? block.text : "")),
      ),
      fallbackPending: runtime.consumeTransportFallback("session-concurrent"),
    }).toStrictEqual({
      closes: 0,
      contents: [["first"], ["second"]],
      fallbackPending: true,
    });
  });

  it("isolates portable summaries from a supplied live session", async () => {
    const windowIds: string[] = [];
    let closes = 0;
    const SummaryWebSocket = function SummaryWebSocket(
      _url: string,
      protocols?: string | string[] | { headers?: Record<string, string> },
    ) {
      const socket = mockSocket();
      socket.readyState = 1;
      if (Value.Check(HeadersInitSchema, protocols)) {
        windowIds.push(protocols.headers?.["x-codex-window-id"] ?? "");
      }
      socket.close = () => {
        closes += 1;
      };
      socket.send = () => {
        for (const event of responseEvents("resp_summary", "summary")) {
          queueMicrotask(() =>
            socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
          );
        }
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", SummaryWebSocket);
    const runtime = createCodexProviderRuntime();
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "portable-summary",
      })
      .result();

    for (let round = 0; round < 10; round += 1) {
      await runtime
        .streamPortableSummary(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          sessionId: "portable-summary",
        })
        .result();
    }
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "portable-summary",
      })
      .result();

    expect({ closes, uniqueWindows: new Set(windowIds).size }).toStrictEqual({
      closes: 10,
      uniqueWindows: 11,
    });
  });

  it.each([
    { abort: true, expectedCloses: 1, expectedSockets: 1, label: "abort" },
    { abort: false, expectedCloses: 2, expectedSockets: 2, label: "timeout" },
  ])(
    "closes sockets that fail to connect by $label",
    async ({ abort, expectedCloses, expectedSockets }) => {
      let closes = 0;
      let sockets = 0;
      const connecting = Promise.withResolvers<null>();
      const ConnectingWebSocket = function ConnectingWebSocket() {
        sockets += 1;
        connecting.resolve(null);
        const socket = mockSocket();
        socket.readyState = 0;
        socket.close = () => {
          closes += 1;
        };
        socket.send = () => null;
        return socket;
      };
      vi.stubGlobal("WebSocket", ConnectingWebSocket);
      const controller = new AbortController();
      const runtime = createCodexProviderRuntime();
      const result = runtime.provider
        .streamSimple(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          fetch: async () => sse(responseEvents("resp_connect", "fallback")),
          sessionId: `session-connect-${abort ? "abort" : "timeout"}`,
          signal: controller.signal,
          transport: "websocket",
          websocketConnectTimeoutMs: 1,
        })
        .result();

      if (abort) {
        await connecting.promise;
        controller.abort();
      }
      const output = await result;
      const fallbackPending = runtime.consumeTransportFallback(
        `session-connect-${abort ? "abort" : "timeout"}`,
      );

      expect({
        closes,
        fallbackPending,
        sockets,
        stopReason: output.stopReason,
      }).toStrictEqual({
        closes: expectedCloses,
        fallbackPending: !abort,
        sockets: expectedSockets,
        stopReason: abort ? "aborted" : "stop",
      });
    },
  );

  it("keeps one pending notice while using sticky SSE", async () => {
    const secret = "secret-token-in-websocket-error";
    let socketAttempts = 0;
    const FailingWebSocket = function FailingWebSocket() {
      socketAttempts += 1;
      throw new Error(secret);
    };
    vi.stubGlobal("WebSocket", FailingWebSocket);
    let responses = 0;
    const fetch = vi.fn<() => Promise<Response>>(async () => {
      responses += 1;
      return responses === 1 ? sse([]) : sse(responseEvents(`resp_fallback_${responses}`, "ok"));
    });
    const runtime = createCodexProviderRuntime();
    const first = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        sessionId: "session-sticky-fallback",
      })
      .result();
    const second = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        sessionId: "session-sticky-fallback",
      })
      .result();
    const third = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        sessionId: "session-sticky-fallback",
      })
      .result();
    const fallbackPending = runtime.consumeTransportFallback("session-sticky-fallback");

    expect({
      fallbackPending,
      firstError: first.errorMessage,
      noticeConsumed: runtime.consumeTransportFallback("session-sticky-fallback"),
      socketAttempts,
      stops: [first.stopReason, second.stopReason, third.stopReason],
    }).toStrictEqual({
      fallbackPending: true,
      firstError: "OpenAI Responses stream ended before a terminal response event",
      noticeConsumed: false,
      socketAttempts: 2,
      stops: ["error", "stop", "stop"],
    });
  });

  it("surfaces a retryable WebSocket error without retrying after stream start", async () => {
    let socketAttempts = 0;
    const FailingWebSocket = function FailingWebSocket() {
      socketAttempts += 1;
      const socket = mockSocket();
      socket.readyState = 1;
      socket.close = () => null;
      socket.send = () => {
        queueMicrotask(() =>
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                response: { id: "resp_ws_failure", status: "in_progress" },
                type: "response.created",
              }),
            }),
          ),
        );
        setTimeout(() => socket.dispatchEvent(new Event("error")), 0);
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", FailingWebSocket);
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_unexpected_retry", "must not retry")),
    );

    const message = await createCodexProviderRuntime()
      .provider.streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        maxRetries: 5,
        onPayload: markProtocolRetryPayload,
        sessionId: "session-ws-stream-failure",
      })
      .result();

    expect({
      diagnostics: message.diagnostics,
      error: message.errorMessage,
      fetches: fetch.mock.calls.length,
      socketAttempts,
      stop: message.stopReason,
    }).toStrictEqual({
      diagnostics: undefined,
      error: "WebSocket error: stream failed",
      fetches: 0,
      socketAttempts: 1,
      stop: "error",
    });
  });

  it("retries WebSocket protocol errors before output", async () => {
    const frames: WireRecord[] = [];
    let connections = 0;
    const ProtocolRetryWebSocket = function ProtocolRetryWebSocket() {
      connections += 1;
      const socket = mockSocket();
      socket.readyState = 1;
      socket.close = () => null;
      socket.send = (data: string) => {
        const frame = wireRecord(JSON.parse(data));
        frames.push(frame);
        const attempt = frames.length;
        let events: readonly WireValue[];
        if (attempt === 1) {
          events = [
            {
              error: {
                code: "websocket_connection_limit_reached",
                message: "too many sockets",
              },
              type: "error",
            },
          ];
        } else if (attempt === 3) {
          events = [
            {
              error: {
                code: "previous_response_not_found",
                message: "missing continuation",
              },
              status: 400,
              type: "error",
            },
          ];
        } else {
          events = responseEvents(`resp_protocol_${attempt}`, `answer ${attempt}`);
        }
        for (const event of events) {
          queueMicrotask(() =>
            socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
          );
        }
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", ProtocolRetryWebSocket);
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_unexpected_sse", "unexpected SSE")),
    );
    const runtime = createCodexProviderRuntime();
    const first = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([{ content: "one", role: "user", timestamp: 1 }]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        onPayload: markProtocolRetryPayload,
        sessionId: "session-ws-protocol-retry",
      })
      .result();
    const second = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
        ]),
        {
          apiKey: SPIKE_API_KEY,
          fetch,
          onPayload: markProtocolRetryPayload,
          sessionId: "session-ws-protocol-retry",
        },
      )
      .result();

    expect({
      connections,
      diagnostics: [first.diagnostics, second.diagnostics],
      fetches: fetch.mock.calls.length,
      previousResponseIds: frames.map((frame) => frame.previous_response_id),
      stops: [first.stopReason, second.stopReason],
    }).toStrictEqual({
      connections: 3,
      diagnostics: [undefined, undefined],
      fetches: 0,
      previousResponseIds: [undefined, undefined, "resp_protocol_2", undefined],
      stops: ["stop", "stop"],
    });
  });

  it("falls back after three partial WebSocket compaction failures", async () => {
    let socketAttempts = 0;
    const PartialCompactionWebSocket = function PartialCompactionWebSocket() {
      socketAttempts += 1;
      const socket = mockSocket();
      socket.readyState = 1;
      socket.close = () => null;
      socket.send = () => {
        queueMicrotask(() =>
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                response: {
                  id: `resp_partial_compact_${socketAttempts}`,
                  status: "in_progress",
                },
                type: "response.created",
              }),
            }),
          ),
        );
        setTimeout(() => socket.dispatchEvent(new Event("error")), 0);
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", PartialCompactionWebSocket);
    const requests: RequestInit[] = [];
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return requestKind(readBody(init?.body)) === "compaction"
          ? sse(compactionEvents("resp_compact_sse_fallback"))
          : sse(responseEvents("resp_after_compact_fallback", "done"));
      },
    );
    vi.stubGlobal("fetch", fetch);
    const runtime = createCodexProviderRuntime();
    const sessionId = "session-partial-compact-fallback";
    const result = await runtime.compact({
      apiKey: SPIKE_API_KEY,
      authoritativeInput: [],
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "threshold",
      sessionId,
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        sessionId,
      })
      .result();

    expect({
      fallbackPending: runtime.consumeTransportFallback(sessionId),
      requestKinds: requests.map((request) => requestKind(readBody(request.body))),
      responseId: result.responseId,
      socketAttempts,
    }).toStrictEqual({
      fallbackPending: true,
      requestKinds: ["compaction", "turn"],
      responseId: "resp_compact_sse_fallback",
      socketAttempts: 3,
    });
  });

  it("records request fingerprints and pre-request compaction failures", async () => {
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const compactionSessionId = "session-pre-request-compaction";
    await expect(
      runtime.compact({
        apiKey: SPIKE_API_KEY,
        authoritativeEnvelope: { input: "malformed" },
        context: context([]),
        effectiveTokenLimit: 1000,
        inputPrefix: [],
        model: SPIKE_MODEL,
        phase: "pre-sampling",
        reason: "manual",
        sessionId: compactionSessionId,
        signal: new AbortController().signal,
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow("Authoritative Codex input is malformed");
    const secret = "request-content-must-not-be-recorded";
    const requestContext = context([{ content: secret, role: "user", timestamp: Date.now() }]);

    await runtime.provider
      .streamSimple(SPIKE_MODEL, requestContext, {
        apiKey: SPIKE_API_KEY,
        cacheRetention: "none",
        fetch: async () => sse(responseEvents("resp_observed", "ok")),
        sessionId: "session-observed",
        transport: "sse",
      })
      .result();
    await runtime.provider
      .streamSimple(SPIKE_MODEL, requestContext, {
        apiKey: SPIKE_API_KEY,
        fetch: async () => sse([]),
        sessionId: "session-observed",
        transport: "sse",
      })
      .result();

    const rows = observability
      .list("session-observed")
      .filter((observation) => observation.kind === "request");
    expect(observability.list(compactionSessionId)[0]?.data).toStrictEqual(
      expect.objectContaining({
        attempts: 0,
        outcome: "error",
      }),
    );
    expect(rows.map((row) => row.data)).toMatchObject([
      {
        outcome: "error",
        request: { stableRequestHash: expect.any(String) },
      },
      {
        outcome: "stop",
        request: {
          cacheEnabled: false,
          stableRequestHash: expect.any(String),
        },
      },
    ]);
    expect(JSON.stringify(rows)).toMatch(/"inputItemHashes":\["[\da-f]{16}"/u);
    expect(JSON.stringify(rows)).not.toContain(secret);
    observability.close();
  });

  it("replaces transformed payloads and retries only retryable compaction errors", async () => {
    const runtime = createCodexProviderRuntime();
    const transformedRequests: RequestInit[] = [];
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async (_input, init) => {
          transformedRequests.push(init ?? {});
          return sse(responseEvents("resp_transform", "ok"));
        },
        onPayload: () => ({ input: [], marker: true }),
        sessionId: "session-transform",
        transport: "sse",
      })
      .result();
    expect(readBody(transformedRequests[0]?.body)).toStrictEqual({
      input: [],
      marker: true,
    });

    vi.stubGlobal("WebSocket", null);
    const compactionSessionId = "session-compaction-classification";
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => sse(responseEvents("resp_compaction_setup", "ok")),
        sessionId: compactionSessionId,
      })
      .result();
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return attempts === 1
        ? sse([
            {
              response: {
                error: { code: "unknown_failure", message: "try again" },
              },
              type: "response.failed",
            },
          ])
        : sse(compactionEvents("resp_retry"));
    });
    const result = await runtime.compact({
      apiKey: SPIKE_API_KEY,
      authoritativeInput: [],
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "manual",
      sessionId: compactionSessionId,
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    expect({ attempts, responseId: result.responseId }).toStrictEqual({
      attempts: 2,
      responseId: "resp_retry",
    });

    let incompleteAttempts = 0;
    vi.stubGlobal("fetch", async () => {
      incompleteAttempts += 1;
      return incompleteAttempts === 1
        ? sse([{ response: { status: "incomplete" }, type: "response.incomplete" }])
        : sse(compactionEvents("resp_after_incomplete"));
    });
    await runtime.compact({
      apiKey: SPIKE_API_KEY,
      authoritativeInput: [],
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "manual",
      sessionId: compactionSessionId,
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    expect(incompleteAttempts).toBe(2);

    let malformedAttempts = 0;
    vi.stubGlobal("fetch", async () => {
      malformedAttempts += 1;
      return sse(responseEvents("resp_no_compaction", "not opaque"));
    });
    await expect(
      runtime.compact({
        apiKey: SPIKE_API_KEY,
        authoritativeInput: [],
        context: context([]),
        effectiveTokenLimit: 1000,
        inputPrefix: [],
        model: SPIKE_MODEL,
        phase: "pre-sampling",
        reason: "manual",
        sessionId: compactionSessionId,
        signal: new AbortController().signal,
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow("invalid response");
    expect(malformedAttempts).toBe(1);
  });

  it.each([
    {
      code: "context_length_exceeded",
      expectedAttempts: 1,
      expectedFallback: true,
    },
    {
      code: "insufficient_quota",
      expectedAttempts: 1,
      expectedFallback: false,
    },
    {
      code: "usage_not_included",
      expectedAttempts: 1,
      expectedFallback: false,
    },
    {
      code: "cyber_policy",
      expectedAttempts: 1,
      expectedFallback: false,
    },
    {
      code: "invalid_prompt",
      expectedAttempts: 1,
      expectedFallback: true,
    },
    {
      code: "server_is_overloaded",
      expectedAttempts: 1,
      expectedFallback: true,
    },
    {
      code: "unknown_failure",
      expectedAttempts: 3,
      expectedFallback: false,
      message: "cyber_policy context_length_exceeded",
    },
  ])(
    "classifies compaction failure $code with exact attempts and fallback",
    async ({ code, expectedAttempts, expectedFallback, message = code }) => {
      vi.stubGlobal("WebSocket", null);
      const sessionId = `session-classification-${code}`;
      const runtime = createCodexProviderRuntime();
      await runtime.provider
        .streamSimple(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          fetch: async () => sse(responseEvents(`resp_setup_${code}`, "ok")),
          sessionId,
        })
        .result();
      let attempts = 0;
      vi.stubGlobal("fetch", async () => {
        attempts += 1;
        return sse([
          {
            response: { error: { code, message } },
            type: "response.failed",
          },
        ]);
      });
      let failure: unknown;
      try {
        await runtime.compact({
          apiKey: SPIKE_API_KEY,
          authoritativeInput: [],
          context: context([]),
          effectiveTokenLimit: 1000,
          inputPrefix: [],
          model: SPIKE_MODEL,
          phase: "pre-sampling",
          reason: "manual",
          sessionId,
          signal: new AbortController().signal,
          thinkingLevel: "medium",
        });
      } catch (error) {
        failure = error;
      }

      expect({
        attempts,
        fallback: isCodexCompactionCurrentModelFallbackError(failure),
      }).toStrictEqual({
        attempts: expectedAttempts,
        fallback: expectedFallback,
      });
    },
  );

  it.each([
    {
      body: { error: { code: "server_is_overloaded", message: "overloaded" } },
      expectedAttempts: 3,
      expectedFallback: true,
      label: "HTTP 500 internal server",
      status: 500,
    },
    {
      body: { error: { code: "teapot", message: "teapot" } },
      expectedAttempts: 1,
      expectedFallback: false,
      label: "unexpected HTTP status",
      status: 418,
    },
    {
      body: {
        error: { code: "rate_limit", message: "usage_not_included" },
      },
      expectedAttempts: 3,
      expectedFallback: true,
      label: "generic HTTP 429",
      status: 429,
    },
    {
      body: {
        error: { message: "usage limit", type: "usage_limit_reached" },
      },
      expectedAttempts: 1,
      expectedFallback: true,
      label: "HTTP 429 usage limit",
      status: 429,
    },
    {
      body: {
        error: { message: "not included", type: "usage_not_included" },
      },
      expectedAttempts: 1,
      expectedFallback: false,
      label: "HTTP 429 usage not included",
      status: 429,
    },
    ...[
      "credit_balance_exhausted",
      "insufficient_quota",
      "organization_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
      "project_spend_limit_exceeded",
    ].map((code) => ({
      body: { error: { code, message: code } },
      expectedAttempts: 1,
      expectedFallback: false,
      label: `HTTP 429 ${code}`,
      status: 429,
    })),
    {
      body: { error: { code: "invalid_image", message: "invalid image" } },
      expectedAttempts: 1,
      expectedFallback: true,
      label: "HTTP 400 structured invalid request",
      status: 400,
    },
    {
      body: { error: { code: "cyber_policy", message: "blocked" } },
      expectedAttempts: 1,
      expectedFallback: false,
      label: "HTTP 400 cyber policy",
      status: 400,
    },
    {
      body: "The image data you provided does not represent a valid image",
      expectedAttempts: 1,
      expectedFallback: false,
      label: "HTTP 400 plain-text invalid image",
      status: 400,
    },
    {
      body: {
        error: {
          message: "The image data you provided does not represent a valid image",
        },
      },
      expectedAttempts: 1,
      expectedFallback: false,
      label: "HTTP 400 JSON invalid image",
      status: 400,
    },
    {
      body: { error: { code: "slow_down", message: "slow down" } },
      expectedAttempts: 1,
      expectedFallback: true,
      label: "HTTP overload",
      status: 503,
    },
  ])(
    "classifies $label for compaction",
    async ({ body, expectedAttempts, expectedFallback, label, status }) => {
      vi.stubGlobal("WebSocket", null);
      const sessionId = `session-http-classification-${label}`;
      const runtime = createCodexProviderRuntime();
      await runtime.provider
        .streamSimple(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          fetch: async () => sse(responseEvents("resp_setup_http", "ok")),
          sessionId,
        })
        .result();
      let attempts = 0;
      vi.stubGlobal("fetch", async () => {
        attempts += 1;
        return Value.Check(StringValueSchema, body)
          ? new Response(body, { status })
          : Response.json(body, { status });
      });
      let failure: unknown;
      try {
        await runtime.compact({
          apiKey: SPIKE_API_KEY,
          authoritativeInput: [],
          context: context([]),
          effectiveTokenLimit: 1000,
          inputPrefix: [],
          model: SPIKE_MODEL,
          phase: "pre-sampling",
          reason: "manual",
          sessionId,
          signal: new AbortController().signal,
          thinkingLevel: "medium",
        });
      } catch (error) {
        failure = error;
      }

      expect({
        attempts,
        fallback: isCodexCompactionCurrentModelFallbackError(failure),
      }).toStrictEqual({
        attempts: expectedAttempts,
        fallback: expectedFallback,
      });
    },
  );

  it("sends canonical V2 compaction metadata on the active turn", async () => {
    vi.stubGlobal("WebSocket", null);
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return sse(compactionEvents("resp_compact"));
    });
    const runtime = createCodexProviderRuntime();
    runtime.beginTurn("session-compact");
    const result = await runtime.compact({
      apiKey: SPIKE_API_KEY,
      authoritativeEnvelope: { service_tier: "flex" },
      authoritativeInput: [
        {
          content: [{ text: "compact me", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      codexReason: "comp_hash_changed",
      context: context([]),
      effectiveTokenLimit: 1000,
      headers: { "x-codex-routing-hint": "model=stale;tier=stale" },
      inputPrefix: [
        {
          content: [{ text: "prefix", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "threshold",
      sessionId: "session-compact",
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    const body = readBody(requests[0]?.body);
    const headers = new Headers(requests[0]?.headers);
    const metadata = wireRecord(
      JSON.parse(wireString(wireRecord(body.client_metadata)["x-codex-turn-metadata"])),
    );
    const compactInput = wireRecords(body.input);

    expect({
      compaction: metadata.compaction,
      headerMetadata: headers.get("x-codex-turn-metadata"),
      requestKind: metadata.request_kind,
      responseId: result.responseId,
      routingHint: headers.get("x-codex-routing-hint"),
      sourceText: compactInput
        .slice(0, -1)
        .map((item) => wireString(wireRecords(item.content)[0]?.text)),
      trigger: compactInput.at(-1)?.type,
    }).toStrictEqual({
      compaction: {
        implementation: "responses_compaction_v2",
        phase: "pre_turn",
        reason: "comp_hash_changed",
        strategy: "memento",
        trigger: "auto",
      },
      headerMetadata: JSON.stringify(metadata),
      requestKind: "compaction",
      responseId: "resp_compact",
      routingHint: `model=${SPIKE_MODEL.id};tier=flex`,
      sourceText: ["prefix", "compact me"],
      trigger: "compaction_trigger",
    });
  });
});
