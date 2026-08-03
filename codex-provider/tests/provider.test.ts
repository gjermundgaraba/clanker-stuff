import { zstdDecompressSync } from "node:zlib";

import type {
  AssistantMessage,
  Context,
  Credential,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCodexProviderRuntime,
  isCodexCompactionCurrentModelFallbackError,
} from "../provider.js";
import { SPIKE_API_KEY, SPIKE_MODEL } from "./fixtures.js";

const sse = (events: readonly unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );

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

const responseEvents = (id: string, text: string) => {
  const message = {
    content: [{ annotations: [], text, type: "output_text" }],
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    type: "message",
  };
  return [
    { response: { id, status: "in_progress" }, type: "response.created" },
    {
      item: { ...message, content: [], status: "in_progress" },
      output_index: 0,
      type: "response.output_item.added",
    },
    {
      content_index: 0,
      delta: text,
      output_index: 0,
      type: "response.output_text.delta",
    },
    { item: message, output_index: 0, type: "response.output_item.done" },
    {
      response: {
        id,
        output: [message],
        status: "completed",
        usage: {
          input_tokens: 8,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 10,
        },
      },
      type: "response.done",
    },
  ];
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
      response: { ...terminal.response, status: "incomplete" },
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

describe("replacement provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      error: message.errorMessage,
      stop: message.stopReason,
    }).toStrictEqual({
      attempts: 1,
      error: "SSE interrupted after output",
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
    const runtime = createCodexProviderRuntime();
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
      requestKinds: requests.map((request) =>
        requestKind(readBody(request.body))
      ),
      websocketAttempts: websocket.mock.calls.length,
    }).toStrictEqual({
      requestKinds: ["compaction", "turn"],
      websocketAttempts: 0,
    });
  });

  it("refreshes full model metadata and restores the projected catalog offline", async () => {
    let stored:
      | Awaited<
          ReturnType<
            Parameters<
              NonNullable<typeof runtime.provider.refreshModels>
            >[0]["store"]["read"]
          >
        >
      | undefined;
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
    const store = {
      delete: async () => {
        stored = undefined;
      },
      read: async () => stored,
      write: async (value: NonNullable<typeof stored>) => {
        stored = structuredClone(value);
      },
    };
    await runtime.provider.refreshModels?.({
      allowNetwork: true,
      credential: { key: SPIKE_API_KEY, type: "api_key" } satisfies Credential,
      store,
    });

    const restored = createCodexProviderRuntime();
    await restored.provider.refreshModels?.({ allowNetwork: false, store });
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
    // oxlint-disable-next-line vitest/max-expects -- one compact protocol matrix
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

  it("releases every portable-summary session and cached socket", async () => {
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

    for (let round = 0; round < 10; round += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each round must observe the prior cleanup
      await runtime
        .streamPortableSummary(SPIKE_MODEL, context([]), {
          apiKey: SPIKE_API_KEY,
          sessionId: "portable-summary",
        })
        .result();
    }

    expect({ closes, uniqueWindows: new Set(windowIds).size }).toStrictEqual({
      closes: 10,
      uniqueWindows: 10,
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
      fetches: fetch.mock.calls.length,
      previousResponseIds: frames.map((frame) => frame.previous_response_id),
      stops: [first.stopReason, second.stopReason],
    }).toStrictEqual({
      connections: 3,
      fetches: 0,
      previousResponseIds: [undefined, undefined, "resp_protocol_2", undefined],
      stops: ["stop", "stop"],
    });
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

    let attempts = 0;
    vi.stubGlobal("WebSocket", null);
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
      phase: "standalone",
      reason: "manual",
      sessionId: "session-retry",
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
      phase: "standalone",
      reason: "manual",
      sessionId: "session-incomplete",
      signal: new AbortController().signal,
      thinkingLevel: "medium",
    });
    expect(incompleteAttempts).toBe(2);

    let malformedAttempts = 0;
    vi.stubGlobal("fetch", async () => {
      malformedAttempts += 1;
      return sse(responseEvents("resp_no_compaction", "not opaque"));
    });
    // oxlint-disable-next-line vitest/max-expects -- one compact protocol matrix
    await expect(
      runtime.compact({
        apiKey: SPIKE_API_KEY,
        authoritativeInput: [],
        context: context([]),
        effectiveTokenLimit: 1000,
        inputPrefix: [],
        model: SPIKE_MODEL,
        phase: "standalone",
        reason: "manual",
        sessionId: "session-malformed",
        signal: new AbortController().signal,
        thinkingLevel: "medium",
      })
    ).rejects.toThrow("invalid response");
    expect(malformedAttempts).toBe(1);

    const responseFailure = async (code: string) => {
      let failureAttempts = 0;
      vi.stubGlobal("fetch", async () => {
        failureAttempts += 1;
        return sse([
          {
            response: { error: { code, message: code } },
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
          phase: "standalone",
          reason: "manual",
          sessionId: `session-${code}`,
          signal: new AbortController().signal,
          thinkingLevel: "medium",
        });
      } catch (error) {
        failure = error;
      }
      return { failure, failureAttempts };
    };
    const contextFailure = await responseFailure("context_length_exceeded");
    const cyberFailure = await responseFailure("cyber_policy");
    const overloadedFailure = await responseFailure("server_is_overloaded");
    // oxlint-disable-next-line vitest/max-expects -- one compact protocol matrix
    expect({
      contextAttempts: contextFailure.failureAttempts,
      contextFallback: isCodexCompactionCurrentModelFallbackError(
        contextFailure.failure
      ),
      cyberAttempts: cyberFailure.failureAttempts,
      cyberFallback: isCodexCompactionCurrentModelFallbackError(
        cyberFailure.failure
      ),
      overloadedAttempts: overloadedFailure.failureAttempts,
      overloadedFallback: isCodexCompactionCurrentModelFallbackError(
        overloadedFailure.failure
      ),
    }).toStrictEqual({
      contextAttempts: 1,
      contextFallback: true,
      cyberAttempts: 1,
      cyberFallback: false,
      overloadedAttempts: 1,
      overloadedFallback: true,
    });

    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: { code: "invalid_request_error", message: "bad model" } },
        { status: 400 }
      )
    );
    // oxlint-disable-next-line vitest/max-expects -- one compact protocol matrix
    await expect(
      runtime.compact({
        apiKey: SPIKE_API_KEY,
        authoritativeInput: [],
        context: context([]),
        effectiveTokenLimit: 1000,
        inputPrefix: [],
        model: SPIKE_MODEL,
        phase: "standalone",
        reason: "manual",
        sessionId: "session-fallback-classification",
        signal: new AbortController().signal,
        thinkingLevel: "medium",
      })
    ).rejects.toSatisfy(isCodexCompactionCurrentModelFallbackError);

    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: { code: "insufficient_quota", message: "quota exceeded" } },
        { status: 429 }
      )
    );
    // oxlint-disable-next-line vitest/max-expects -- one compact protocol matrix
    await expect(
      runtime.compact({
        apiKey: SPIKE_API_KEY,
        authoritativeInput: [],
        context: context([]),
        effectiveTokenLimit: 1000,
        inputPrefix: [],
        model: SPIKE_MODEL,
        phase: "standalone",
        reason: "manual",
        sessionId: "session-quota-classification",
        signal: new AbortController().signal,
        thinkingLevel: "medium",
      })
    ).rejects.not.toSatisfy(isCodexCompactionCurrentModelFallbackError);
  });

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
