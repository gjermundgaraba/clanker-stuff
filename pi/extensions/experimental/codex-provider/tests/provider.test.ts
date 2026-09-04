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

type ScriptedSocket = ReturnType<typeof mockSocket>;

const socketEvent = (
  socket: ScriptedSocket,
  type: "close" | "error" | "open",
  properties?: { code?: number; message?: string },
  delayed = false,
) => {
  const emit = () => {
    const event = new Event(type);
    for (const [name, value] of Object.entries(properties ?? {})) {
      Object.defineProperty(event, name, { value });
    }
    socket.dispatchEvent(event);
  };
  if (delayed) {
    setTimeout(emit, 0);
  } else {
    queueMicrotask(emit);
  }
};

const socketMessage = (socket: ScriptedSocket, value: WireValue) => {
  queueMicrotask(() => {
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  });
};

const scriptedWebSocket = (script: {
  close?: (socket: ScriptedSocket) => void;
  connect?: (socket: ScriptedSocket) => void;
  readyState?: number;
  send: (socket: ScriptedSocket, data: string) => void;
}) =>
  function ScriptedWebSocket() {
    const socket = mockSocket(script.readyState);
    socket.close = () => {
      script.close?.(socket);
    };
    socket.send = (data) => {
      script.send(socket, data);
    };
    (script.connect ?? ((value) => socketEvent(value, "open")))(socket);
    return socket;
  };

const recoveryObservation = (observability: CodexObservability, sessionId: string) => {
  const observation = wireRecord(observability.list(sessionId)[0]?.data);
  const transport = wireRecord(observation.transport);
  return {
    ...transport,
    attempts: wireRecords(transport.inferenceAttempts).map((attempt) =>
      [
        attempt.ordinal,
        attempt.transport,
        attempt.continuationMode,
        attempt.responseCreated,
        attempt.failureClass,
        attempt.finalDecision,
      ].join("|"),
    ),
    transportUsed: transport.transportUsed,
  };
};

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
      model_messages: {
        multi_agent: { mode: { proactive: "Catalog proactive policy." } },
      },
      multi_agent_reasoning_effort: "medium",
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
      multi_agent_version: "v2",
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

interface RemoteCatalogPayload {
  readonly models: readonly object[];
}

const fetchRemoteCatalog = async (remoteCatalog: RemoteCatalogPayload = REMOTE_CATALOG) => {
  const catalog = createCodexModelCatalog();
  const runtime = createProviderRuntime(defaultObservability, () => false, catalog);
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
      ? Response.json(remoteCatalog, {
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
  return { catalog, getStored, publish, requests, runtime, signal };
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
          toolChoice: "none",
          transport: "sse",
        },
      )
      .result();

    const body = readBody(requests[0]?.body);
    const [standardMessage] = wireRecords(body.input);
    const [standardImage] = wireRecords(standardMessage?.content);
    const clientMetadata = wireRecord(body.client_metadata);
    const turnMetadata = wireRecord(
      JSON.parse(wireString(clientMetadata["x-codex-turn-metadata"])),
    );
    const requestHeaders = new Headers(requests[0]?.headers);
    expect({
      callbackCounts: [payloads.length, responses.length],
      clientMetadata: turnMetadata,
      diagnostics: message.diagnostics,
      endTurn: message.endTurn,
      header: requestHeaders.get("x-openai-internal-codex-responses-lite"),
      instructions: body.instructions,
      output: message.content,
      requestCount: requests.length,
      standardImage,
      store: body.store,
      toolChoice: body.tool_choice,
      tools: wireRecords(body.tools).map(({ name, type }) => ({
        name,
        type,
      })),
      windowHeader: requestHeaders.get("x-codex-window-id"),
      windowProjection: clientMetadata["x-codex-window-id"],
    }).toMatchObject({
      callbackCounts: [1, 1],
      clientMetadata: {
        context_window_id: expect.any(String),
        request_kind: "turn",
        session_id: "session-sse",
        thread_id: "session-sse",
        window_id: "session-sse:0",
        window_number: 0,
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
      toolChoice: "none",
      tools: [
        { name: "exec", type: "custom" },
        { name: "wait", type: "function" },
      ],
      windowHeader: "session-sse:0",
      windowProjection: "session-sse:0",
    });
    expect(clientMetadata["x-codex-turn-metadata"]).toStrictEqual(expect.any(String));
  });

  it("keeps restored window identity across turns and standalone compaction", async () => {
    const requests: RequestInit[] = [];
    const runtime = createCodexProviderRuntime();
    const sessionId = "session-restored-window";
    const contextWindowId = "019c1234-5678-7000-8000-000000000000";
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const request = init ?? {};
      requests.push(request);
      return requestKind(readBody(request.body)) === "compaction"
        ? sse(compactionEvents("resp_restored_compaction"))
        : sse(responseEvents("resp_restored_window", "done"));
    });
    runtime.installWindow(sessionId, {
      currentWindowId: contextWindowId,
      previousWindowId: "019c1234-5678-7000-8000-000000000001",
      windowNumber: 4,
    });
    runtime.beginTurn(sessionId);

    await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId,
        transport: "sse",
      })
      .result();
    runtime.endTurn(sessionId);
    await runtime.compact({
      apiKey: SPIKE_API_KEY,
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model: SPIKE_MODEL,
      phase: "standalone",
      reason: "manual",
      sessionId,
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });

    const expectedWindow = {
      canonical: {
        context_window_id: contextWindowId,
        window_id: `${sessionId}:4`,
        window_number: 4,
      },
      header: `${sessionId}:4`,
      projection: `${sessionId}:4`,
    };
    expect(
      requests.map((request) => {
        const metadata = wireRecord(readBody(request.body).client_metadata);
        return {
          canonical: wireRecord(JSON.parse(wireString(metadata["x-codex-turn-metadata"]))),
          header: new Headers(request.headers).get("x-codex-window-id"),
          projection: metadata["x-codex-window-id"],
        };
      }),
    ).toMatchObject([expectedWindow, expectedWindow]);
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
      promptCacheKeys: requests.map((request) => request.prompt_cache_key),
      serviceTiers: requests.map((request) => request.service_tier),
      supportsFastMode: runtime.supportsFastMode(FAST_MODEL),
    }).toStrictEqual({
      promptCacheKeys: ["session-fast", "session-fast"],
      serviceTiers: ["priority", "priority"],
      supportsFastMode: true,
    });
    expect(compaction.usage.cost.total).toBeCloseTo(2.4e-5, 10);
    expect(message.usage.cost.total).toBeCloseTo(2.4e-5, 10);
  });

  it("applies live fast mode to inline compaction and later turns", async () => {
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
      { kind: "compaction", tier: "priority" },
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

  it("isolates response.created while retrying one SSE dispatch", async () => {
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-sse-created-retry";
    let dispatches = 0;
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => {
          dispatches += 1;
          return dispatches === 1
            ? interruptedSse({
                response: { id: "resp_discarded", status: "in_progress" },
                type: "response.created",
              })
            : sse(responseEvents("resp_winner", "winner"));
        },
        maxRetries: 1,
        sessionId,
        transport: "sse",
      })
      .result();

    expect([dispatches, message.responseId, message.stopReason]).toStrictEqual([
      2,
      "resp_winner",
      "stop",
    ]);
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: [
        "1|sse|full|discarded|transport_stream|retry_sse",
        "2|sse|full|committed|none|completed",
      ],
      freshReplayBudget: 1,
      inferenceDispatches: 2,
    });
    observability.close();
  });

  it.each([
    {
      attempt: "1|sse|full|discarded|transport_stream|replay_budget_exhausted",
      budget: 0,
      dispatches: 1,
      error: "SSE interrupted after output",
      fetch: async () =>
        interruptedSse({
          response: { id: "resp_discarded", status: "in_progress" },
          type: "response.created",
        }),
      label: "keeps response.created recovery disabled by default",
    },
    {
      attempt: "1|sse|full|absent|transport_stream|replay_budget_exhausted",
      budget: 0,
      dispatches: 1,
      error: "OpenAI Responses stream ended before a terminal response event",
      fetch: async () => sse([]),
      label: "records empty SSE as a failed attempt",
    },
    {
      attempt: "1|sse|full|absent|transport_stream|fail_closed",
      budget: 0,
      dispatches: 1,
      error: "OpenAI Responses stream ended before a terminal response event",
      fetch: async () =>
        sse([{ headers: { "x-codex-turn-state": "opaque" }, type: "response.metadata" }]),
      label: "records non-terminal SSE as a failed attempt",
    },
    {
      attempt: "1|sse|full|absent|transport_dispatch|surfaced",
      budget: 0,
      dispatches: 0,
      error: "fetch failed before dispatch",
      fetch: (): Promise<Response> => {
        throw new Error("fetch failed before dispatch");
      },
      label: "does not count a synchronous fetch throw as an inference dispatch",
    },
    {
      attempt: "1|sse|full|absent|authentication|surfaced",
      budget: 1,
      dispatches: 1,
      error: "unauthorized",
      fetch: async () =>
        Response.json(
          { error: { code: "unauthorized", message: "unauthorized" } },
          { status: 401 },
        ),
      label: "does not retry HTTP 401 responses",
      maxRetries: 1,
    },
    {
      attempt: "1|sse|full|absent|http_retryable|fail_closed",
      budget: 1,
      dispatches: 1,
      error: "server failed after installing turn state",
      fetch: async () =>
        Response.json(
          { error: { code: "server_error", message: "server failed after installing turn state" } },
          { headers: { "x-codex-turn-state": "opaque" }, status: 500 },
        ),
      label: "does not retry an HTTP failure after installing response-header turn state",
      maxRetries: 1,
    },
  ])("$label", async ({ attempt, budget, dispatches, error, fetch, label, maxRetries }) => {
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = `session-sse-failure-${label}`;
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        maxRetries,
        sessionId,
        transport: "sse",
      })
      .result();

    expect([message.errorMessage, message.responseId, message.stopReason]).toStrictEqual([
      error,
      undefined,
      "error",
    ]);
    const recovery = recoveryObservation(observability, sessionId);
    expect(recovery).toMatchObject({
      attempts: [attempt],
      freshReplayBudget: budget,
      inferenceDispatches: dispatches,
    });
    expect(recovery.transportUsed).toBe(dispatches === 0 ? undefined : "sse");
    observability.close();
  });

  it("caps generic HTTP 429 recovery at one replay", async () => {
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
      attempts: 2,
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

  it("keeps a terminal SSE attempt completed when response validation fails afterward", async () => {
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-terminal-sse-error";
    const events = incompleteResponseEvents("resp_terminal_error", "partial answer");
    const terminal = wireRecord(events.at(-1));
    const response = wireRecord(terminal.response);
    response.incomplete_details = { reason: "content_filter" };
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () => sse(events),
        sessionId,
        transport: "sse",
      })
      .result();

    expect(message.stopReason).toBe("error");
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: ["1|sse|full|committed|none|completed"],
      inferenceDispatches: 1,
    });
    observability.close();
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

  it("restores authoritative remote models and reprojects cached selectors offline", async () => {
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
    const restored = await restoreCatalog({
      ...stored,
      models: stored.models.map((model) =>
        model.id === "gpt-5.6-remote"
          ? {
              ...model,
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
            }
          : model,
      ),
    });
    const omitted = await restoreCatalog({
      ...stored,
      models: stored.models.filter((model) => model.id !== "gpt-5.6-luna"),
    });
    const restoredRemote = restored.provider
      .getModels()
      .find((model) => model.id === "gpt-5.6-remote");

    expect({
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
      restoredRemoteCatalog: restored.provider
        .getModels()
        .some((model) => model.id === "gpt-5.6-remote"),
      restoredRemoteProjection: {
        reasoning: restoredRemote?.reasoning,
        thinkingLevelMap: restoredRemote?.thinkingLevelMap,
      },
      routingHint: requests[0]?.headers.get("x-codex-routing-hint"),
    }).toStrictEqual({
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
      restoredRemoteCatalog: true,
      restoredRemoteProjection: {
        reasoning: true,
        thinkingLevelMap: {
          high: null,
          low: null,
          max: "max",
          medium: "medium",
          minimal: null,
          off: null,
          xhigh: null,
        },
      },
      routingHint: null,
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
    const { catalog, runtime } = await fetchRemoteCatalog();
    const [remoteModel] = runtime.provider.getModels();
    if (!remoteModel) {
      throw new Error("Remote model was not projected");
    }

    expect({
      metadata: runtime.getModelMetadata(remoteModel.id)?.comp_hash,
      model: remoteModel,
      supportsFastMode: runtime.supportsFastMode(remoteModel),
      ultra: catalog.getUltraSettings(remoteModel),
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
      ultra: {
        proactivePolicy: "Catalog proactive policy.",
        reasoningLevel: "medium",
      },
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
      ultra: catalog.getUltraSettings(nullLimitModel),
      window: runtime.getModelWindow(nullLimitModel),
    }).toStrictEqual({
      reasoning: true,
      thinkingLevelMap: {
        high: null,
        low: null,
        max: null,
        medium: "medium",
        minimal: null,
        off: null,
        xhigh: null,
      },
      ultra: { reasoningLevel: "medium" },
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

  it("preserves Ultra none reasoning for turns and compaction", async () => {
    const { catalog, runtime } = await fetchRemoteCatalog({
      models: [
        {
          ...REMOTE_CATALOG.models[0],
          default_reasoning_level: "high",
          multi_agent_reasoning_effort: "none",
          supported_reasoning_levels: ["none", "ultra"].map((effort) => ({ effort })),
        },
      ],
    });
    const [model] = runtime.provider.getModels();
    if (!model) {
      throw new Error("Remote model was not projected");
    }
    const requests: WireRecord[] = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = readBody(init?.body);
      requests.push(body);
      return requestKind(body) === "compaction"
        ? sse(compactionEvents("resp_none_compaction"))
        : sse(responseEvents("resp_none_turn", "done"));
    });

    await runtime.provider
      .streamSimple(model, context([]), {
        apiKey: SPIKE_API_KEY,
        sessionId: "session-none",
        transport: "sse",
      })
      .result();
    await runtime.compact({
      apiKey: SPIKE_API_KEY,
      context: context([]),
      effectiveTokenLimit: 1000,
      inputPrefix: [],
      model,
      phase: "standalone",
      reason: "manual",
      sessionId: "session-none",
      signal: new AbortController().signal,
      thinkingLevel: "off",
    });

    expect({
      efforts: requests.map((request) => wireRecord(request.reasoning).effort),
      reasoning: model.reasoning,
      ultra: catalog.getUltraSettings(model),
    }).toStrictEqual({
      efforts: ["none", "none"],
      reasoning: false,
      ultra: {
        proactivePolicy: "Catalog proactive policy.",
        reasoningLevel: "off",
      },
    });
  });

  it("falls back to the last representable Ultra reasoning level", async () => {
    const { catalog, runtime } = await fetchRemoteCatalog({
      models: [
        {
          ...REMOTE_CATALOG.models[0],
          multi_agent_reasoning_effort: undefined,
          supported_reasoning_levels: ["none", "ultra"].map((effort) => ({ effort })),
        },
      ],
    });

    expect(catalog.getUltraSettings(runtime.provider.getModels()[0])).toStrictEqual({
      proactivePolicy: "Catalog proactive policy.",
      reasoningLevel: "off",
    });
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
        requestKind: requestKind(frame),
        windowId: wireRecord(frame.client_metadata)["x-codex-window-id"],
      })),
    ).toStrictEqual([
      {
        inputTypes: ["additional_tools", "message"],
        previousResponseId: undefined,
        requestKind: "prewarm",
        windowId: "session-lite-ws:0",
      },
      {
        inputTypes: ["additional_tools", "message", "user"],
        previousResponseId: undefined,
        requestKind: "turn",
        windowId: "session-lite-ws:0",
      },
    ]);
    const ssePrefixIds = liteInput.slice(0, 2).map((item) => item.id);
    const websocketPrefixIds = liteFrames.map((frame) =>
      wireRecords(frame.input)
        .slice(0, 2)
        .map((item) => item.id),
    );
    expect(websocketPrefixIds[0]).toStrictEqual(websocketPrefixIds[1]);
    expect(websocketPrefixIds[0]).not.toStrictEqual(ssePrefixIds);
    expect(websocketPrefixIds[0]).toStrictEqual([
      expect.stringMatching(/^at_[0-9a-f-]{36}$/u),
      expect.stringMatching(/^msg_[0-9a-f-]{36}$/u),
    ]);
  });

  it("gives Responses Lite prefix payloads stable thread-sensitive IDs", async () => {
    const { getStored } = await fetchRemoteCatalog();
    const runtime = await restoreCatalog(getStored());
    const [model] = runtime.provider.getModels();
    if (!model) {
      throw new Error("Cached remote model was not restored");
    }
    const requests: RequestInit[] = [];
    const run = async (sessionId: string, systemPrompt: string, tools = CODE_MODE_TOOLS) => {
      await runtime.provider
        .streamSimple(
          model,
          {
            ...context([]),
            systemPrompt,
            tools,
          },
          {
            apiKey: SPIKE_API_KEY,
            fetch: async (_input, init) => {
              requests.push(init ?? {});
              return sse(responseEvents(`resp_prefix_${requests.length}`, "done"));
            },
            sessionId,
            transport: "sse",
          },
        )
        .result();
    };

    await run("lite-prefix-thread", "System truth");
    await run("lite-prefix-thread", "System truth");
    await run("lite-prefix-thread", "Different instructions");
    await run("lite-prefix-thread", "System truth", []);
    await run("lite-prefix-other-thread", "System truth");

    const prefixes = requests.map((request) =>
      wireRecords(readBody(request.body).input)
        .slice(0, 2)
        .map((item) => item.id),
    );
    expect(prefixes[0]).toStrictEqual(prefixes[1]);
    expect(prefixes[0]?.[0]).toStrictEqual(prefixes[2]?.[0]);
    expect(prefixes[0]?.[1]).not.toStrictEqual(prefixes[2]?.[1]);
    expect(prefixes[0]?.[0]).not.toStrictEqual(prefixes[3]?.[0]);
    expect(prefixes[0]).not.toStrictEqual(prefixes[4]);
    expect(wireRecords(readBody(requests[3]?.body).input)[0]?.tools).toStrictEqual([]);
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
    const reasoningItem = {
      content: [{ text: "reasoning body", type: "reasoning_text" }],
      encrypted_content: "encrypted-reasoning",
      id: "rs_rich",
      provider_reasoning_metadata: { retained: true },
      status: "completed",
      summary: [{ text: "reasoning summary", type: "summary_text" }],
      type: "reasoning",
    };
    const functionItem = {
      arguments: '{ "cell_id": "cell-1", "toString": null, "yield_time_ms": 1000 }',
      call_id: "call_function",
      id: "fc_function",
      name: "wait",
      provider_function_metadata: { omitted: true },
      status: "completed",
      type: "function_call",
    };
    const customItem = {
      call_id: "call_custom",
      id: "ctc_custom",
      input: "console.log('rich')",
      name: "exec",
      provider_custom_metadata: { omitted: true },
      status: "completed",
      type: "custom_tool_call",
    };
    const messageItem = {
      content: [
        {
          annotations: [{ label: "provider-only" }],
          logprobs: [{ token: "answer" }],
          text: "answer 1",
          type: "output_text",
        },
      ],
      id: "msg_rich",
      phase: "final_answer",
      provider_message_metadata: { omitted: true },
      role: "assistant",
      status: "completed",
      type: "message",
    };
    const richOutput = [reasoningItem, functionItem, customItem, messageItem];
    const doneOutput = [
      {
        ...reasoningItem,
        encrypted_content: "",
      },
      functionItem,
      customItem,
      messageItem,
    ];
    const richResponseEvents = [
      {
        response: { id: "resp_ws_1", status: "in_progress" },
        type: "response.created",
      },
      {
        headers: { "x-codex-turn-state": "turn-state-1" },
        type: "response.metadata",
      },
      ...doneOutput.map((item, output_index) => ({
        item,
        output_index,
        type: "response.output_item.done",
      })),
      {
        response: {
          end_turn: false,
          id: "resp_ws_1",
          output: richOutput,
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
    const responseEventsWithoutTerminalOutput = (id: string, text: string) => {
      const events: WireValue[] = responseEvents(id, text, false);
      const terminal = wireRecord(events.at(-1));
      const response = wireRecord(terminal.response);
      delete response.output;
      return [...events.slice(0, -1), { ...terminal, response }];
    };
    const frames: WireRecord[] = [];
    const handshakeHints: string[] = [];
    const sockets: MockWebSocket[] = [];
    const socketUrls: string[] = [];
    let closes = 0;
    let fastMode = false;
    let responseNumber = 0;
    class MockWebSocket {
      readyState = 1;
      private readonly listeners = new Map<string, Set<(event: WireValue) => void>>();

      constructor(
        url: string,
        protocols?: string | string[] | { headers?: Record<string, string> },
      ) {
        sockets.push(this);
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
        this.readyState = 3;
        this.listeners.clear();
      }

      removeEventListener(type: string, listener: (event: WireValue) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      send(data: string) {
        const frame = wireRecord(JSON.parse(data));
        frames.push(frame);
        if (frame.generate !== false) {
          responseNumber += 1;
        }
        const events =
          frame.generate === false
            ? [
                {
                  response: {
                    id: "prewarm",
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
            : responseNumber === 1
              ? richResponseEvents
              : responseNumber === 4
                ? responseEventsWithoutTerminalOutput(
                    `resp_ws_${responseNumber}`,
                    `answer ${responseNumber}`,
                  )
                : responseEvents(`resp_ws_${responseNumber}`, `answer ${responseNumber}`, false);
        for (const event of events) {
          queueMicrotask(() => this.emit("message", { data: JSON.stringify(event) }));
        }
      }

      retire() {
        this.readyState = 3;
        this.emit("close", {});
      }

      private emit(type: string, event: WireValue) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    const runtime = createCodexProviderRuntime(defaultObservability, () => fastMode);
    const sessionId = "session-ws";
    const socketModel = {
      ...FAST_MODEL,
      compat: { supportsOpenAIGrammarTools: true },
    };
    const socketContext = (messages: Context["messages"]): Context => ({
      ...context(messages),
      tools: CODE_MODE_TOOLS,
    });
    let messages: Context["messages"] = [{ content: "one", role: "user", timestamp: 1 }];
    runtime.beginTurn(sessionId);
    const first = await runtime.provider
      .streamSimple(socketModel, socketContext(messages), {
        apiKey: SPIKE_API_KEY,
        sessionId,
      })
      .result();
    expect(defaultObservability.list(sessionId)[0]?.data).toMatchObject({
      transport: {
        inferenceDispatches: 1,
        prewarmAttempts: 1,
        prewarmDispatches: 1,
        websocketHandshakeAttempts: 1,
        websocketHandshakeFailures: 0,
      },
    });
    const functionCall = first.content.find(
      (block) => block.type === "toolCall" && block.name === functionItem.name,
    );
    const customCall = first.content.find(
      (block) => block.type === "toolCall" && block.name === customItem.name,
    );
    if (functionCall?.type !== "toolCall" || customCall?.type !== "toolCall") {
      throw new Error("Rich response did not produce both tool calls");
    }
    messages = [
      ...messages,
      assistantMessage(first),
      {
        content: [{ text: "function result", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: 2,
        toolCallId: functionCall.id,
        toolName: functionCall.name,
      },
      {
        content: [{ text: "custom result", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: 3,
        toolCallId: customCall.id,
        toolName: customCall.name,
      },
      { content: "two", role: "user", timestamp: 4 },
    ];
    const second = await runtime.provider
      .streamSimple(socketModel, socketContext(messages), { apiKey: SPIKE_API_KEY, sessionId })
      .result();
    const socketCountBeforeClose = sockets.length;
    sockets[0]?.retire();
    messages = [
      ...messages,
      assistantMessage(second),
      { content: "three", role: "user", timestamp: 5 },
    ];
    let afterClosePayload: WireValue = null;
    const third = await runtime.provider
      .streamSimple(socketModel, socketContext(messages), {
        apiKey: SPIKE_API_KEY,
        onPayload: (payload) => {
          afterClosePayload = structuredClone(payload);
        },
        sessionId,
      })
      .result();
    runtime.endTurn(sessionId);
    fastMode = true;
    runtime.beginTurn(sessionId);
    messages = [
      ...messages,
      assistantMessage(third),
      { content: "four", role: "user", timestamp: 6 },
    ];
    const fourth = await runtime.provider
      .streamSimple(socketModel, socketContext(messages), { apiKey: SPIKE_API_KEY, sessionId })
      .result();
    messages = [
      ...messages,
      assistantMessage(fourth),
      { content: "five", role: "user", timestamp: 7 },
    ];
    const fifth = await runtime.provider
      .streamSimple(socketModel, socketContext(messages), { apiKey: SPIKE_API_KEY, sessionId })
      .result();
    const otherApiKey = apiKeyForAccount("account-other");
    messages = [
      ...messages,
      assistantMessage(fifth),
      { content: "six", role: "user", timestamp: 8 },
    ];
    const sixth = await runtime.provider
      .streamSimple(socketModel, socketContext(messages), { apiKey: otherApiKey, sessionId })
      .result();
    messages = [
      ...messages,
      assistantMessage(sixth),
      { content: "seven", role: "user", timestamp: 9 },
    ];
    await runtime.provider
      .streamSimple(
        { ...socketModel, baseUrl: "https://example.test/backend-api" },
        socketContext(messages),
        { apiKey: otherApiKey, sessionId },
      )
      .result();

    const generated = frames.filter((frame) => frame.generate !== false);
    const prewarm = frames.find((frame) => frame.generate === false);
    const requestBodyFromFrame = (frame: WireRecord) => {
      const body = structuredClone(frame);
      delete body.generate;
      delete body.type;
      const metadata = wireRecord(body.client_metadata);
      delete metadata["x-codex-turn-state"];
      delete metadata["x-codex-ws-stream-request-start-ms"];
      body.client_metadata = metadata;
      return body;
    };
    const deltaAfterRichOutput = generated[1];
    const fullAfterClose = generated[2];
    const simplifiedDelta = generated[4];
    if (!deltaAfterRichOutput || !fullAfterClose || !simplifiedDelta) {
      throw new Error("Expected continuation frames were not observed");
    }
    expect(deltaAfterRichOutput.input).toStrictEqual([
      {
        call_id: functionItem.call_id,
        output: "function result",
        type: "function_call_output",
      },
      {
        call_id: customItem.call_id,
        output: "custom result",
        type: "custom_tool_call_output",
      },
      {
        content: [{ text: "two", type: "input_text" }],
        role: "user",
      },
    ]);
    expect(simplifiedDelta.input).toStrictEqual([
      {
        content: [{ text: "five", type: "input_text" }],
        role: "user",
      },
    ]);
    const reconstructedItems = wireRecords(fullAfterClose.input);
    const reconstructedReasoning = reconstructedItems.find(
      (item) => item.type === "reasoning" && item.id === reasoningItem.id,
    );
    const reconstructedFunction = reconstructedItems.find(
      (item) => item.call_id === functionItem.call_id,
    );
    const reconstructedMessage = reconstructedItems.find((item) => item.id === messageItem.id);
    expect({
      body: requestBodyFromFrame(fullAfterClose),
      previousResponseId: fullAfterClose.previous_response_id,
      reasoning: reconstructedReasoning,
      normalizedFields: {
        function: Object.keys(reconstructedFunction ?? {}).toSorted(),
        message: Object.keys(reconstructedMessage ?? {}).toSorted(),
      },
    }).toStrictEqual({
      body: wireRecord(JSON.parse(JSON.stringify(afterClosePayload))),
      previousResponseId: undefined,
      reasoning: reasoningItem,
      normalizedFields: {
        function: ["arguments", "call_id", "id", "name", "type"],
        message: ["content", "id", "phase", "role", "status", "type"],
      },
    });
    expect({
      closes,
      endTurns: [first.endTurn, second.endTurn],
      handshakeHints,
      inputLengths: generated.map((frame) => wireRecords(frame.input).length),
      previousResponseIds: generated.map((frame) => frame.previous_response_id),
      prewarmInput: prewarm?.input,
      requestCount: generated.length,
      requestKinds: frames.map(requestKind),
      socketCountBeforeClose,
      socketUrls,
      turnStates: generated.map((frame) => wireRecord(frame.client_metadata)["x-codex-turn-state"]),
    }).toStrictEqual({
      closes: 4,
      endTurns: [false, false],
      handshakeHints: [
        `model=${FAST_MODEL.id}`,
        `model=${FAST_MODEL.id}`,
        `model=${FAST_MODEL.id};tier=priority`,
        `model=${FAST_MODEL.id};tier=priority`,
        `model=${FAST_MODEL.id};tier=priority`,
      ],
      inputLengths: [1, 3, 10, 12, 1, 16, 18],
      previousResponseIds: [
        undefined,
        "resp_ws_1",
        undefined,
        undefined,
        "resp_ws_4",
        undefined,
        undefined,
      ],
      prewarmInput: [],
      requestCount: 7,
      requestKinds: ["prewarm", "turn", "turn", "turn", "turn", "turn", "turn", "turn"],
      socketCountBeforeClose: 1,
      socketUrls: [
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://phase-zero.invalid/backend-api/codex/responses",
        "wss://example.test/backend-api/codex/responses",
      ],
      turnStates: [
        undefined,
        "turn-state-1",
        "turn-state-1",
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    });
  });

  it.each([
    {
      expectedReconstruction: {
        content: [{ annotations: [], text: "done text", type: "output_text" }],
        id: "msg_projection",
        role: "assistant",
        status: "completed",
        type: "message",
      },
      item: {
        content: [{ text: "done text", type: "output_text" }],
        id: "msg_projection",
        role: "assistant",
        status: "completed",
        type: "message",
      },
      label: "conflicting terminal output",
      sessionId: "session-terminal-projection",
      terminalItem: {
        content: [{ text: "terminal text", type: "output_text" }],
        id: "msg_projection",
        role: "assistant",
        status: "completed",
        type: "message",
      },
    },
    {
      expectedReconstruction: {
        arguments: '{"overflow":null}',
        call_id: "call_numeric",
        id: "fc_numeric",
        name: "numeric_tool",
        type: "function_call",
      },
      item: {
        arguments: '{"overflow":1e400}',
        call_id: "call_numeric",
        id: "fc_numeric",
        name: "numeric_tool",
        status: "completed",
        type: "function_call",
      },
      label: "overflowing function numbers",
      sessionId: "session-overflow-projection",
    },
    {
      expectedReconstruction: {
        arguments: '{"unsafe":9007199254740992}',
        call_id: "call_numeric",
        id: "fc_numeric",
        name: "numeric_tool",
        type: "function_call",
      },
      item: {
        arguments: '{"unsafe":9007199254740993}',
        call_id: "call_numeric",
        id: "fc_numeric",
        name: "numeric_tool",
        status: "completed",
        type: "function_call",
      },
      label: "unsafe function integers",
      sessionId: "session-unsafe-projection",
    },
    {
      expectedReconstruction: {
        arguments: '{"input":"transformed input"}',
        call_id: "call_transformed",
        name: "transformed_custom",
        type: "function_call",
      },
      item: {
        call_id: "call_transformed",
        id: "ctc_transformed",
        input: "transformed input",
        name: "transformed_custom",
        status: "completed",
        type: "custom_tool_call",
      },
      label: "unmapped custom tool",
      sessionId: "session-custom-projection",
    },
    {
      expectedReconstruction: undefined,
      item: {
        id: "search_unsupported",
        query: "provider-only search",
        status: "completed",
        type: "web_search_call",
      },
      label: "unsupported output",
      sessionId: "session-unsupported-projection",
    },
  ])("keeps the socket but sends a full request after $label", async (fixture) => {
    const frames: WireRecord[] = [];
    let connections = 0;
    let generated = 0;
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        connect: (socket) => {
          connections += 1;
          socketEvent(socket, "open");
        },
        send: (socket, data) => {
          const frame = wireRecord(JSON.parse(data));
          frames.push(frame);
          if (frame.generate === false) {
            socketMessage(socket, {
              response: {
                id: "prewarm",
                output: [],
                status: "completed",
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              },
              type: "response.done",
            });
            return;
          }
          generated += 1;
          const events =
            generated === 1
              ? [
                  {
                    response: { id: "resp_projection", status: "in_progress" },
                    type: "response.created",
                  },
                  {
                    item: fixture.item,
                    output_index: 0,
                    type: "response.output_item.done",
                  },
                  {
                    response: {
                      id: "resp_projection",
                      output: [fixture.terminalItem ?? fixture.item],
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
                ]
              : responseEvents("resp_projection_followup", "followup");
          for (const event of events) {
            socketMessage(socket, event);
          }
        },
      }),
    );
    const runtime = createCodexProviderRuntime();
    const initial = { content: "one", role: "user" as const, timestamp: 1 };
    const first = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([initial]), {
        apiKey: SPIKE_API_KEY,
        sessionId: fixture.sessionId,
      })
      .result();
    const messages: Context["messages"] = [initial, assistantMessage(first)];
    const toolCall = first.content.find((block) => block.type === "toolCall");
    if (toolCall?.type === "toolCall") {
      messages.push({
        content: [{ text: "tool result", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: 2,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
    }
    messages.push({ content: "two", role: "user", timestamp: 3 });
    let finalizedRequest: WireValue = null;
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context(messages), {
        apiKey: SPIKE_API_KEY,
        onPayload: (payload) => {
          finalizedRequest = structuredClone(payload);
        },
        sessionId: fixture.sessionId,
      })
      .result();

    const generatedFrames = frames.filter((frame) => frame.generate !== false);
    const followup = generatedFrames[1];
    if (!followup) {
      throw new Error("Projection fallback request was not observed");
    }
    const callId = fixture.item.call_id;
    const reconstructed = wireRecords(followup.input).find(
      (item) =>
        (Value.Check(StringValueSchema, callId) && item.call_id === callId) ||
        (item.id === fixture.item.id && item.type === fixture.item.type),
    );
    expect({
      connections,
      input: followup.input,
      previousResponseId: followup.previous_response_id,
      reconstructed,
      requestCount: generatedFrames.length,
    }).toStrictEqual({
      connections: 1,
      input: wireRecord(JSON.parse(JSON.stringify(finalizedRequest))).input,
      previousResponseId: undefined,
      reconstructed: fixture.expectedReconstruction,
      requestCount: 2,
    });
    runtime.closeSession(fixture.sessionId);
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

  it.each([
    {
      abort: true,
      expectedCloses: 1,
      expectedHandshakeFailures: 0,
      expectedInferenceDispatches: 0,
      expectedSockets: 1,
      label: "abort",
    },
    {
      abort: false,
      expectedCloses: 2,
      expectedHandshakeFailures: 2,
      expectedInferenceDispatches: 1,
      expectedSockets: 2,
      label: "timeout",
    },
  ])(
    "closes sockets that fail to connect by $label",
    async ({
      abort,
      expectedCloses,
      expectedHandshakeFailures,
      expectedInferenceDispatches,
      expectedSockets,
    }) => {
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
      const observability = new CodexObservability(":memory:");
      const runtime = createCodexProviderRuntime(observability);
      const sessionId = `session-connect-${abort ? "abort" : "timeout"}`;
      const result = runtime.provider
        .streamSimple(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          fetch: async () => sse(responseEvents("resp_connect", "fallback")),
          sessionId,
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
      const fallbackPending = runtime.consumeTransportFallback(sessionId);

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
      expect(recoveryObservation(observability, sessionId)).toMatchObject({
        inferenceDispatches: expectedInferenceDispatches,
        prewarmAttempts: 1,
        prewarmDispatches: 0,
        sseFallbackActivated: !abort,
        websocketHandshakeAttempts: expectedSockets,
        websocketHandshakeFailures: expectedHandshakeFailures,
      });
      observability.close();
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

  it("does not count a WebSocket send throw as an inference dispatch", async () => {
    let sends = 0;
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: () => {
          sends += 1;
          throw new Error("send failed before dispatch");
        },
      }),
    );
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_send_fallback", "fallback")),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-send-throw";
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        onPayload: markProtocolRetryPayload,
        sessionId,
        transport: "websocket",
      })
      .result();

    expect([sends, fetch.mock.calls.length, message.stopReason]).toStrictEqual([1, 1, "stop"]);
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: [
        "1|websocket|full|absent|transport_dispatch|fallback_to_sse",
        "2|sse|full|committed|none|completed",
      ],
      inferenceDispatches: 1,
      prewarmAttempts: 0,
      prewarmDispatches: 0,
      websocketHandshakeAttempts: 1,
      websocketHandshakeFailures: 0,
    });
    observability.close();
  });

  it("does not record transport use when WebSocket and SSE throw before dispatch", async () => {
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: () => {
          throw new Error("send failed before dispatch");
        },
      }),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-transport-dispatch-throws";
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: () => {
          throw new Error("fetch failed before dispatch");
        },
        onPayload: markProtocolRetryPayload,
        sessionId,
        transport: "websocket",
      })
      .result();

    expect(message.stopReason).toBe("error");
    const recovery = recoveryObservation(observability, sessionId);
    expect(recovery).toMatchObject({
      attempts: [
        "1|websocket|full|absent|transport_dispatch|fallback_to_sse",
        "2|sse|full|absent|transport_dispatch|surfaced",
      ],
      inferenceDispatches: 0,
      sseFallbackActivated: true,
    });
    expect(recovery.transportUsed).toBeUndefined();
    observability.close();
  });

  it("discards buffered response.created when a WebSocket request is aborted", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: (socket) => {
          socketMessage(socket, {
            response: { id: "resp_must_not_escape", status: "in_progress" },
            type: "response.created",
          });
          setTimeout(() => controller.abort(), 0);
        },
      }),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-created-abort";
    const stream = runtime.provider.streamSimple(SPIKE_MODEL, context([]), {
      apiKey: SPIKE_API_KEY,
      onPayload: markProtocolRetryPayload,
      sessionId,
      signal: controller.signal,
      transport: "websocket",
    });
    const eventTypes: string[] = [];
    let responseId: string | undefined;
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "error") {
        responseId = event.error.responseId;
      }
    }

    expect([eventTypes, responseId, runtime.consumeTransportFallback(sessionId)]).toStrictEqual([
      ["error"],
      undefined,
      false,
    ]);
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: ["1|websocket|full|discarded|abort|aborted"],
      inferenceDispatches: 1,
    });
    observability.close();
  });

  it.each([
    {
      label: "metadata",
      nextEvent: {
        headers: { "x-codex-turn-state": "opaque-turn-state" },
        type: "response.metadata",
      },
    },
    { label: "unknown events", nextEvent: { type: "future.unknown" } },
  ])("keeps $label fail-closed", async ({ label, nextEvent }) => {
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: (socket) => {
          socketMessage(socket, {
            response: { id: "resp_fail_closed", status: "in_progress" },
            type: "response.created",
          });
          socketMessage(socket, nextEvent);
          socketEvent(socket, "error", undefined, true);
        },
      }),
    );
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_unsafe_retry", "must not retry")),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = `session-fail-closed-${label}`;
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        maxRetries: 1,
        onPayload: markProtocolRetryPayload,
        sessionId,
        transport: "websocket",
      })
      .result();

    expect([fetch.mock.calls.length, message.stopReason]).toStrictEqual([0, "error"]);
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: ["1|websocket|full|committed|transport_stream|fail_closed"],
      inferenceDispatches: 1,
    });
    observability.close();
  });

  it("closes a socket when downstream event validation stops its stream", async () => {
    let closes = 0;
    let connections = 0;
    let sends = 0;
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        close: () => {
          closes += 1;
        },
        connect: (socket) => {
          connections += 1;
          socketEvent(socket, "open");
        },
        send: (socket) => {
          sends += 1;
          if (sends === 1) {
            socketMessage(socket, { type: 1 });
            return;
          }
          for (const event of responseEvents("resp_after_validation", "recovered")) {
            socketMessage(socket, event);
          }
        },
      }),
    );
    const fetch = vi.fn<() => Promise<Response>>();
    const runtime = createCodexProviderRuntime();
    const options = {
      apiKey: SPIKE_API_KEY,
      fetch,
      onPayload: markProtocolRetryPayload,
      sessionId: "session-downstream-validation",
      transport: "websocket" as const,
    };

    const first = await runtime.provider.streamSimple(SPIKE_MODEL, context([]), options).result();
    const second = await runtime.provider.streamSimple(SPIKE_MODEL, context([]), options).result();

    expect({
      closes,
      connections,
      fetches: fetch.mock.calls.length,
      sends,
      stops: [first.stopReason, second.stopReason],
    }).toStrictEqual({
      closes: 1,
      connections: 2,
      fetches: 0,
      sends: 2,
      stops: ["error", "stop"],
    });
  });

  it("shares one replay across WebSocket fallback and SSE retry", async () => {
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: (socket) => {
          socketMessage(socket, {
            response: { id: "resp_ws_discarded", status: "in_progress" },
            type: "response.created",
          });
          socketEvent(socket, "error", undefined, true);
        },
      }),
    );
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      interruptedSse({
        response: { id: "resp_sse_discarded", status: "in_progress" },
        type: "response.created",
      }),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-shared-replay";
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch,
        maxRetries: 5,
        onPayload: markProtocolRetryPayload,
        sessionId,
      })
      .result();

    expect([fetch.mock.calls.length, message.stopReason]).toStrictEqual([1, "error"]);
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: [
        "1|websocket|full|discarded|transport_stream|fallback_to_sse",
        "2|sse|full|discarded|transport_stream|replay_budget_exhausted",
      ],
      freshReplayBudget: 1,
      inferenceDispatches: 2,
      sseFallbackActivated: true,
    });
    observability.close();
  });

  it.each([
    {
      handshakeFailure: false,
      expectedAttempts: [
        "1|websocket|delta|absent|protocol_missing_continuation|retry_websocket",
        "2|websocket|full|discarded|transport_stream|replay_budget_exhausted",
      ],
      label: "blocks SSE after continuation repair consumes the replay",
    },
    {
      handshakeFailure: true,
      expectedAttempts: [
        "1|websocket|delta|absent|protocol_missing_continuation|retry_websocket",
        "2|sse|full|committed|none|completed",
      ],
      label: "keeps repair attribution after a replacement handshake failure",
    },
  ])("$label", async ({ expectedAttempts, handshakeFailure }) => {
    const frames: WireRecord[] = [];
    let connections = 0;
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        connect: (socket) => {
          connections += 1;
          socketEvent(socket, handshakeFailure && connections === 2 ? "error" : "open");
        },
        send: (socket, data) => {
          frames.push(wireRecord(JSON.parse(data)));
          if (frames.length === 1) {
            for (const event of responseEvents("resp_repair_seed", "seed")) {
              socketMessage(socket, event);
            }
          } else if (frames.length === 2) {
            socketMessage(socket, {
              error: {
                code: "previous_response_not_found",
                message: "missing continuation",
              },
              type: "error",
            });
          } else {
            socketMessage(socket, {
              response: { id: "resp_discarded", status: "in_progress" },
              type: "response.created",
            });
            socketEvent(socket, "error", undefined, true);
          }
        },
      }),
    );
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_repair_sse", "fallback")),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = `session-continuation-${handshakeFailure}`;
    const options = {
      apiKey: SPIKE_API_KEY,
      fetch,
      maxRetries: 1,
      onPayload: markProtocolRetryPayload,
      sessionId,
    };
    const first = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([{ content: "one", role: "user", timestamp: 1 }]), options)
      .result();
    const second = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          assistantMessage(first),
          { content: "two", role: "user", timestamp: 2 },
        ]),
        options,
      )
      .result();

    expect({
      connections,
      fetches: fetch.mock.calls.length,
      previousResponseIds: frames.map((frame) => frame.previous_response_id),
      stop: second.stopReason,
    }).toStrictEqual({
      connections: 2,
      fetches: handshakeFailure ? 1 : 0,
      previousResponseIds: handshakeFailure
        ? [undefined, "resp_repair_seed"]
        : [undefined, "resp_repair_seed", undefined],
      stop: handshakeFailure ? "stop" : "error",
    });
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: expectedAttempts,
      inferenceDispatches: 2,
      missingContinuationRetries: 1,
      websocketHandshakeAttempts: 1,
      websocketHandshakeFailures: handshakeFailure ? 1 : 0,
    });
    observability.close();
  });

  it.each([
    {
      code: "websocket_connection_limit_reached",
      counter: "connectionLimitRetries",
      failure: "protocol_connection_limit",
    },
    {
      code: "previous_response_not_found",
      counter: "missingContinuationRetries",
      failure: "protocol_missing_continuation",
    },
  ])("uses the shared opt-in replay for $code", async ({ code, counter, failure }) => {
    let sends = 0;
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: (socket) => {
          sends += 1;
          if (sends === 1) {
            socketMessage(socket, { error: { code, message: "retry" }, type: "error" });
          } else {
            for (const event of responseEvents("resp_protocol_retry", "recovered")) {
              socketMessage(socket, event);
            }
          }
        },
      }),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = `session-protocol-${code}`;
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        maxRetries: 1,
        onPayload: markProtocolRetryPayload,
        sessionId,
      })
      .result();

    const recovery = recoveryObservation(observability, sessionId);
    expect([sends, message.stopReason]).toStrictEqual([2, "stop"]);
    expect(recovery).toMatchObject({
      [counter]: 1,
      attempts: [
        `1|websocket|full|absent|${failure}|retry_websocket`,
        "2|websocket|full|committed|none|completed",
      ],
      inferenceDispatches: 2,
    });
    observability.close();
  });

  it("does not retry a WebSocket protocol error with the default budget", async () => {
    let sends = 0;
    vi.stubGlobal(
      "WebSocket",
      scriptedWebSocket({
        send: (socket) => {
          sends += 1;
          socketMessage(socket, {
            error: {
              code: "websocket_connection_limit_reached",
              message: "too many sockets",
            },
            type: "error",
          });
        },
      }),
    );
    const observability = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observability);
    const sessionId = "session-protocol-default-zero";
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        onPayload: markProtocolRetryPayload,
        sessionId,
      })
      .result();

    expect([sends, message.errorMessage]).toStrictEqual([1, "too many sockets"]);
    expect(recoveryObservation(observability, sessionId)).toMatchObject({
      attempts: ["1|websocket|full|absent|protocol_connection_limit|replay_budget_exhausted"],
      connectionLimitRetries: 0,
      inferenceDispatches: 1,
    });
    observability.close();
  });

  it.each([
    {
      closeCode: undefined,
      expectedAttempts: ["1|sse|full|committed|none|completed"],
      expectedFetches: 1,
      handshakeStatus: 426,
      label: "HTTP 426 handshake",
    },
    {
      closeCode: 1009,
      expectedAttempts: ["1|websocket|full|absent|transport_stream|replay_budget_exhausted"],
      expectedFetches: 0,
      handshakeStatus: undefined,
      label: "WebSocket close 1009",
    },
  ])(
    "keeps $label classification unchanged",
    async ({ closeCode, expectedAttempts, expectedFetches, handshakeStatus }) => {
      vi.stubGlobal(
        "WebSocket",
        scriptedWebSocket({
          connect: (socket) =>
            socketEvent(
              socket,
              handshakeStatus === undefined ? "open" : "error",
              handshakeStatus === undefined
                ? undefined
                : { message: `Unexpected server response: ${handshakeStatus}` },
            ),
          readyState: handshakeStatus === undefined ? 1 : 0,
          send: (socket) => {
            if (closeCode !== undefined) {
              socketEvent(socket, "close", { code: closeCode });
            }
          },
        }),
      );
      const fetch = vi.fn<() => Promise<Response>>(async () =>
        sse(responseEvents("resp_handshake_fallback", "fallback")),
      );
      const observability = new CodexObservability(":memory:");
      const runtime = createCodexProviderRuntime(observability);
      const sessionId = `session-regression-${handshakeStatus ?? closeCode}`;
      const message = await runtime.provider
        .streamSimple(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          fetch,
          onPayload: markProtocolRetryPayload,
          sessionId,
          transport: "websocket",
        })
        .result();

      expect({
        fallback: runtime.consumeTransportFallback(sessionId),
        fetches: fetch.mock.calls.length,
        stop: message.stopReason,
      }).toStrictEqual({
        fallback: true,
        fetches: expectedFetches,
        stop: handshakeStatus === undefined ? "error" : "stop",
      });
      expect(recoveryObservation(observability, sessionId)).toMatchObject({
        attempts: expectedAttempts,
        inferenceDispatches: 1,
        sseFallbackActivated: true,
        transportUsed: handshakeStatus === undefined ? "websocket" : "sse",
        websocketHandshakeAttempts: 1,
        websocketHandshakeFailures: handshakeStatus === undefined ? 0 : 1,
      });
      observability.close();
    },
  );

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

  it("replaces transformed payloads and preserves private compaction retries", async () => {
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
        ? Response.json(
            { error: { code: "rate_limit", message: "try again" } },
            { headers: { "retry-after-ms": "999999" }, status: 429 },
          )
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
      contextWindowId: metadata.context_window_id,
      headerMetadata: headers.get("x-codex-turn-metadata"),
      requestKind: metadata.request_kind,
      responseId: result.responseId,
      routingHint: headers.get("x-codex-routing-hint"),
      sourceText: compactInput
        .slice(0, -1)
        .map((item) => wireString(wireRecords(item.content)[0]?.text)),
      trigger: compactInput.at(-1)?.type,
      windowHeader: headers.get("x-codex-window-id"),
      windowId: metadata.window_id,
      windowNumber: metadata.window_number,
    }).toStrictEqual({
      compaction: {
        implementation: "responses_compaction_v2",
        phase: "pre_turn",
        reason: "comp_hash_changed",
        strategy: "memento",
        trigger: "auto",
      },
      contextWindowId: expect.any(String),
      headerMetadata: JSON.stringify(metadata),
      requestKind: "compaction",
      responseId: "resp_compact",
      routingHint: `model=${SPIKE_MODEL.id};tier=flex`,
      sourceText: ["prefix", "compact me"],
      trigger: "compaction_trigger",
      windowHeader: "session-compact:0",
      windowId: "session-compact:0",
      windowNumber: 0,
    });
  });
});
