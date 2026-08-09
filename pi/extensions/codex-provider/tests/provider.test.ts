import { zstdDecompressSync } from "node:zlib";

import type {
  AssistantMessage,
  Context,
  Credential,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CodexObservability } from "../observability.js";
import {
  createCodexProviderRuntime as createProviderRuntime,
  isCodexCompactionCurrentModelFallbackError,
} from "../provider.js";
import { responseEvents, SPIKE_API_KEY, SPIKE_MODEL, sse } from "./fixtures.js";

const defaultObservability = new CodexObservability(":memory:");
const createCodexProviderRuntime = (observability = defaultObservability) =>
  createProviderRuntime(observability);

const interruptedSse = (firstEvent: unknown) => {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify(firstEvent)}\n\n`
  );
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
    { headers: { "content-type": "text/event-stream" } }
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

const compactionEvents = (id: string) => [
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

const readBody = (body: RequestInit["body"]) => {
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, unknown>;
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(zstdDecompressSync(body).toString("utf-8")) as Record<
      string,
      unknown
    >;
  }
  throw new Error("Unexpected request body");
};

const requestKind = (frame: Record<string, unknown>) =>
  JSON.parse(
    (frame.client_metadata as Record<string, string>)["x-codex-turn-metadata"]
  ).request_kind as string;

const markProtocolRetryPayload = (payload: unknown) => ({
  ...(payload as Record<string, unknown>),
  protocolRetryTest: true,
});

describe("Codex provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    defaultObservability.close();
  });

  it("preserves Pi callbacks and builds a complete SSE request", async () => {
    const runtime = createCodexProviderRuntime();
    const payloads: unknown[] = [];
    const requests: RequestInit[] = [];
    const responses: number[] = [];
    const message = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([{ content: "hello", role: "user", timestamp: 1 }]),
        {
          apiKey: SPIKE_API_KEY,
          fetch: async (_input, init) => {
            requests.push(init ?? {});
            return sse(responseEvents("resp_sse", "hello back"));
          },
          onPayload: (payload) => {
            payloads.push(payload);
          },
          onResponse: ({ status }) => {
            responses.push(status);
          },
          sessionId: "session-sse",
          transport: "sse",
        }
      )
      .result();

    const body = readBody(requests[0]?.body);
    expect({
      callbackCounts: [payloads.length, responses.length],
      clientMetadata: JSON.parse(
        (body.client_metadata as Record<string, string>)[
          "x-codex-turn-metadata"
        ]
      ),
      diagnostics: message.diagnostics,
      instructions: body.instructions,
      output: message.content,
      requestCount: requests.length,
      store: body.store,
    }).toMatchObject({
      callbackCounts: [1, 1],
      clientMetadata: {
        request_kind: "turn",
        session_id: "session-sse",
        thread_id: "session-sse",
      },
      diagnostics: undefined,
      instructions: "System truth",
      output: [{ text: "hello back", type: "text" }],
      requestCount: 1,
      store: false,
    });
    expect(
      (body.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"]
    ).toStrictEqual(expect.any(String));
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
            { status: 429 }
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

  it("returns incomplete responses as length stops", async () => {
    const runtime = createCodexProviderRuntime();
    const message = await runtime.provider
      .streamSimple(SPIKE_MODEL, context([]), {
        apiKey: SPIKE_API_KEY,
        fetch: async () =>
          sse(incompleteResponseEvents("resp_incomplete", "partial answer")),
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
    vi.stubGlobal(
      "fetch",
      async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return requestKind(readBody(init?.body)) === "compaction"
          ? sse(compactionEvents("resp_inline_compact"))
          : sse(responseEvents("resp_after_compact", "done"));
      }
    );

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
      requestKinds: requests.map((request) =>
        requestKind(readBody(request.body))
      ),
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

  it("refreshes full model metadata and restores the projected catalog offline", async () => {
    type RefreshContext = Parameters<
      NonNullable<
        ReturnType<
          typeof createCodexProviderRuntime
        >["provider"]["refreshModels"]
      >
    >[0];
    type StoreEntry = NonNullable<RefreshContext["stored"]>;
    let stored: StoreEntry | undefined;
    const publish: RefreshContext["publish"] = async (publication) => {
      if (publication.persist === null) {
        stored = undefined;
      } else if (publication.persist !== undefined) {
        stored = structuredClone(publication.persist);
      }
      publication.update?.();
      return true;
    };
    const { signal } = new AbortController();
    const runtime = createCodexProviderRuntime();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json(
          {
            models: [
              {
                auto_compact_token_limit: 150_000,
                comp_hash: "comp-a",
                context_window: 200_000,
                default_reasoning_level: "medium",
                default_reasoning_summary: "concise",
                display_name: "Remote Codex",
                effective_context_window_percent: 95,
                priority: 1,
                slug: "remote-codex",
                support_verbosity: true,
                supported_in_api: true,
                supported_reasoning_levels: [
                  { description: "Balanced", effort: "medium" },
                  { description: "Deepest", effort: "ultra" },
                ],
                supports_parallel_tool_calls: true,
                supports_reasoning_summary_parameter: true,
                use_responses_lite: true,
                visibility: "list",
              },
              {
                auto_compact_token_limit: null,
                comp_hash: "comp-null-limit",
                context_window: 272_000,
                display_name: "No Reasoning",
                priority: 2,
                slug: SPIKE_MODEL.id,
                support_verbosity: true,
                supported_in_api: true,
                supported_reasoning_levels: [],
                supports_parallel_tool_calls: true,
                visibility: "list",
              },
            ],
          },
          { headers: { etag: '"catalog-1"' } }
        );
      }
    );
    await runtime.provider.refreshModels?.({
      allowNetwork: true,
      credential: { key: SPIKE_API_KEY, type: "api_key" } satisfies Credential,
      publish,
      signal,
      stored,
    });

    const restored = createCodexProviderRuntime();
    await restored.provider.refreshModels?.({
      allowNetwork: false,
      publish,
      signal,
      stored,
    });
    const liteRequests: RequestInit[] = [];
    const [remoteModel] = runtime.provider.getModels();
    await runtime.provider
      .streamSimple(
        remoteModel,
        {
          ...context([]),
          tools: [
            {
              description: "Remote tool",
              name: "remote_tool",
              parameters: { properties: {}, type: "object" },
            },
          ],
        },
        {
          apiKey: SPIKE_API_KEY,
          fetch: async (_input, init) => {
            liteRequests.push(init ?? {});
            return sse(responseEvents("resp_lite", "lite"));
          },
          sessionId: "session-lite",
          transport: "sse",
        }
      )
      .result();
    const liteBody = readBody(liteRequests[0]?.body);
    const liteHeaders = new Headers(liteRequests[0]?.headers);
    expect({
      lite: {
        header: liteHeaders.get("x-openai-internal-codex-responses-lite"),
        instructions: liteBody.instructions,
        prefix: (liteBody.input as Record<string, unknown>[])
          .slice(0, 2)
          .map((item) => item.type),
        reasoning: liteBody.reasoning,
      },
      metadata: runtime.getModelMetadata("remote-codex")?.comp_hash,
      model: runtime.provider.getModels()[0],
      request: requests[0]?.url,
      restoredRemoteCatalog: restored.provider
        .getModels()
        .some((model) => model.id === "remote-codex"),
      window: runtime.getModelWindow(remoteModel),
    }).toMatchObject({
      lite: {
        header: "true",
        instructions: "",
        prefix: ["additional_tools", "message"],
        reasoning: {
          context: "all_turns",
          effort: "medium",
          summary: "concise",
        },
      },
      metadata: "comp-a",
      model: { contextWindow: 200_000, id: "remote-codex" },
      request: expect.stringContaining("/codex/models?client_version="),
      restoredRemoteCatalog: false,
      window: {
        autoCompactTokens: 150_000,
        effectiveWindowTokens: 190_000,
      },
    });
    expect(remoteModel.thinkingLevelMap).toMatchObject({
      high: null,
      low: null,
      max: "ultra",
      medium: "medium",
      minimal: null,
      off: null,
    });
    expect(
      runtime.provider.getModels().find((model) => model.id === SPIKE_MODEL.id)
    ).toMatchObject({
      reasoning: false,
      thinkingLevelMap: {
        high: null,
        low: null,
        medium: null,
        minimal: null,
        off: null,
      },
    });
    const nullLimitModel = runtime.provider
      .getModels()
      .find((model) => model.id === SPIKE_MODEL.id);
    if (!nullLimitModel) {
      throw new Error("Null-limit model was not projected");
    }
    expect(runtime.getModelWindow(nullLimitModel)).toStrictEqual({
      autoCompactTokens: 244_800,
      effectiveWindowTokens: 258_400,
    });

    const liteFrames: Record<string, unknown>[] = [];
    const LiteWebSocket = function LiteWebSocket() {
      const socket = new EventTarget() as EventTarget & {
        close: () => void;
        readyState: number;
        send: (data: string) => void;
      };
      socket.readyState = 1;
      socket.close = () => null;
      socket.send = (data: string) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
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
            socket.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(event) })
            )
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
          ...context([{ content: "live", role: "user", timestamp: 1 }]),
          tools: [
            {
              description: "Remote tool",
              name: "remote_tool",
              parameters: { properties: {}, type: "object" },
            },
          ],
        },
        { apiKey: SPIKE_API_KEY, sessionId: "session-lite-ws" }
      )
      .result();
    expect(
      liteFrames.map((frame) => ({
        inputTypes: (frame.input as Record<string, unknown>[]).map(
          (item) => item.type ?? item.role
        ),
        previousResponseId: frame.previous_response_id,
      }))
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

  it("reuses one socket and sends only an exact continuation delta", async () => {
    const frames: Record<string, unknown>[] = [];
    let responseNumber = 0;
    class MockWebSocket {
      readonly readyState = 1;
      private readonly listeners = new Map<
        string,
        Set<(event: unknown) => void>
      >();

      constructor() {
        queueMicrotask(() => this.emit("open", {}));
      }

      addEventListener(type: string, listener: (event: unknown) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      close() {
        this.listeners.clear();
      }

      removeEventListener(type: string, listener: (event: unknown) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      send(data: string) {
        const frame = JSON.parse(data) as Record<string, unknown>;
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
                ...responseEvents(id, `answer ${responseNumber}`),
              ];
        for (const event of events) {
          queueMicrotask(() =>
            this.emit("message", { data: JSON.stringify(event) })
          );
        }
      }

      private emit(type: string, event: unknown) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    const runtime = createCodexProviderRuntime();
    runtime.beginTurn("session-ws");
    const first = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([{ content: "one", role: "user", timestamp: 1 }]),
        { apiKey: SPIKE_API_KEY, sessionId: "session-ws" }
      )
      .result();
    const second = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          first as AssistantMessage,
          { content: "two", role: "user", timestamp: 2 },
        ]),
        { apiKey: SPIKE_API_KEY, sessionId: "session-ws" }
      )
      .result();
    runtime.endTurn("session-ws");
    runtime.beginTurn("session-ws");
    await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          first as AssistantMessage,
          { content: "two", role: "user", timestamp: 2 },
          second as AssistantMessage,
          { content: "three", role: "user", timestamp: 3 },
        ]),
        { apiKey: SPIKE_API_KEY, sessionId: "session-ws" }
      )
      .result();

    const generated = frames.filter((frame) => frame.generate !== false);
    const prewarm = frames.find((frame) => frame.generate === false);
    expect({
      delta: (generated[1]?.input as unknown[])?.length,
      firstDelta: (generated[0]?.input as unknown[])?.length,
      firstPreviousResponseId: generated[0]?.previous_response_id,
      previousResponseIds: generated
        .slice(1)
        .map((frame) => frame.previous_response_id),
      prewarmInput: prewarm?.input,
      requestCount: generated.length,
      requestKinds: frames.map(requestKind),
      turnStates: generated.map(
        (frame) =>
          (frame.client_metadata as Record<string, string>)[
            "x-codex-turn-state"
          ]
      ),
    }).toStrictEqual({
      delta: 1,
      firstDelta: 1,
      firstPreviousResponseId: undefined,
      previousResponseIds: ["resp_ws_2", "resp_ws_3"],
      prewarmInput: [],
      requestCount: 3,
      requestKinds: ["prewarm", "turn", "turn", "turn"],
      turnStates: [undefined, "turn-state-1", undefined],
    });
  });

  it("falls back concurrent same-session work without closing the busy socket", async () => {
    let closes = 0;
    let activeSocket: EventTarget | undefined;
    const requestStarted = Promise.withResolvers<null>();
    const BusyWebSocket = function BusyWebSocket() {
      const socket = new EventTarget() as EventTarget & {
        close: () => void;
        readyState: number;
        send: (data: string) => void;
      };
      activeSocket = socket;
      socket.readyState = 1;
      socket.close = () => {
        closes += 1;
      };
      socket.send = (data) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.generate === false) {
          queueMicrotask(() =>
            socket.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  response: { id: "prewarm", status: "completed" },
                  type: "response.done",
                }),
              })
            )
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
      activeSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(event) })
      );
    }
    const first = await firstResult;

    expect({
      closes,
      contents: [first, second].map((message) =>
        message.content.map((block) => ("text" in block ? block.text : ""))
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
      protocols?: string | string[] | { headers?: Record<string, string> }
    ) {
      const socket = new EventTarget() as EventTarget & {
        close: () => void;
        readyState: number;
        send: () => void;
      };
      socket.readyState = 1;
      if (typeof protocols === "object" && !Array.isArray(protocols)) {
        windowIds.push(protocols.headers?.["x-codex-window-id"] ?? "");
      }
      socket.close = () => {
        closes += 1;
      };
      socket.send = () => {
        for (const event of responseEvents("resp_summary", "summary")) {
          queueMicrotask(() =>
            socket.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(event) })
            )
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
      // oxlint-disable-next-line eslint/no-await-in-loop -- each round must observe the prior cleanup
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
        const socket = new EventTarget() as EventTarget & {
          close: () => void;
          readyState: number;
          send: () => void;
        };
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
        `session-connect-${abort ? "abort" : "timeout"}`
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
    }
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
      return responses === 1
        ? sse([])
        : sse(responseEvents(`resp_fallback_${responses}`, "ok"));
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
    const fallbackPending = runtime.consumeTransportFallback(
      "session-sticky-fallback"
    );

    expect({
      fallbackPending,
      firstError: first.errorMessage,
      noticeConsumed: runtime.consumeTransportFallback(
        "session-sticky-fallback"
      ),
      socketAttempts,
      stops: [first.stopReason, second.stopReason, third.stopReason],
    }).toStrictEqual({
      fallbackPending: true,
      firstError:
        "OpenAI Responses stream ended before a terminal response event",
      noticeConsumed: false,
      socketAttempts: 2,
      stops: ["error", "stop", "stop"],
    });
  });

  it("surfaces a retryable WebSocket error without retrying after stream start", async () => {
    let socketAttempts = 0;
    const FailingWebSocket = function FailingWebSocket() {
      socketAttempts += 1;
      const socket = new EventTarget() as EventTarget & {
        close: () => void;
        readyState: number;
        send: () => void;
      };
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
            })
          )
        );
        setTimeout(() => socket.dispatchEvent(new Event("error")), 0);
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", FailingWebSocket);
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_unexpected_retry", "must not retry"))
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
    const frames: Record<string, unknown>[] = [];
    let connections = 0;
    const ProtocolRetryWebSocket = function ProtocolRetryWebSocket() {
      connections += 1;
      const socket = new EventTarget() as EventTarget & {
        close: () => void;
        readyState: number;
        send: (data: string) => void;
      };
      socket.readyState = 1;
      socket.close = () => null;
      socket.send = (data: string) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
        frames.push(frame);
        const attempt = frames.length;
        let events: readonly unknown[];
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
          events = responseEvents(
            `resp_protocol_${attempt}`,
            `answer ${attempt}`
          );
        }
        for (const event of events) {
          queueMicrotask(() =>
            socket.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(event) })
            )
          );
        }
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", ProtocolRetryWebSocket);
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      sse(responseEvents("resp_unexpected_sse", "unexpected SSE"))
    );
    const runtime = createCodexProviderRuntime();
    const first = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([{ content: "one", role: "user", timestamp: 1 }]),
        {
          apiKey: SPIKE_API_KEY,
          fetch,
          onPayload: markProtocolRetryPayload,
          sessionId: "session-ws-protocol-retry",
        }
      )
      .result();
    const second = await runtime.provider
      .streamSimple(
        SPIKE_MODEL,
        context([
          { content: "one", role: "user", timestamp: 1 },
          first as AssistantMessage,
          { content: "two", role: "user", timestamp: 2 },
        ]),
        {
          apiKey: SPIKE_API_KEY,
          fetch,
          onPayload: markProtocolRetryPayload,
          sessionId: "session-ws-protocol-retry",
        }
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
      const socket = new EventTarget() as EventTarget & {
        close: () => void;
        readyState: number;
        send: () => void;
      };
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
            })
          )
        );
        setTimeout(() => socket.dispatchEvent(new Event("error")), 0);
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", PartialCompactionWebSocket);
    const requests: RequestInit[] = [];
    const fetch = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return requestKind(readBody(init?.body)) === "compaction"
        ? sse(compactionEvents("resp_compact_sse_fallback"))
        : sse(responseEvents("resp_after_compact_fallback", "done"));
    });
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
      requestKinds: requests.map((request) =>
        requestKind(readBody(request.body))
      ),
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
      })
    ).rejects.toThrow("Authoritative Codex input is malformed");
    const secret = "request-content-must-not-be-recorded";
    const requestContext = context([
      { content: secret, role: "user", timestamp: Date.now() },
    ]);

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
      })
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
        ? sse([
            { response: { status: "incomplete" }, type: "response.incomplete" },
          ])
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
      })
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
    }
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
      expectedAttempts: 3,
      expectedFallback: true,
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
          message:
            "The image data you provided does not represent a valid image",
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
        return typeof body === "string"
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
    }
  );

  it("sends canonical V2 compaction metadata on the active turn", async () => {
    vi.stubGlobal("WebSocket", null);
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return sse(compactionEvents("resp_compact"));
      }
    );
    const runtime = createCodexProviderRuntime();
    runtime.beginTurn("session-compact");
    const result = await runtime.compact({
      apiKey: SPIKE_API_KEY,
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
    const metadata = JSON.parse(
      (body.client_metadata as Record<string, string>)["x-codex-turn-metadata"]
    ) as Record<string, unknown>;

    expect({
      compaction: metadata.compaction,
      headerMetadata: headers.get("x-codex-turn-metadata"),
      requestKind: metadata.request_kind,
      responseId: result.responseId,
      sourceText: (body.input as Record<string, unknown>[])
        .slice(0, -1)
        .map(
          (item) =>
            (item.content as Record<string, unknown>[])[0]?.text as string
        ),
      trigger: (body.input as Record<string, unknown>[]).at(-1)?.type,
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
      sourceText: ["prefix", "compact me"],
      trigger: "compaction_trigger",
    });
  });
});
