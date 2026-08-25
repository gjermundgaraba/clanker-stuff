import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type { AssistantMessage, FetchFunction, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHECKPOINT_CUSTOM_TYPE,
  nativeCheckpointSummary,
  resolveActiveCheckpointBoundary,
  resolveCheckpointCarrier,
} from "../checkpoint.js";
import codexCompactionExtension from "../index.js";
import { CodexObservability } from "../observability.js";
import { FRAME_MARKER_PREFIX } from "../replay.js";
import { createRealCodexSession } from "./agent-session.js";
import {
  createToolsModel,
  mockUiContext,
  SPIKE_MODEL,
  wireArray,
  wireRecord,
  WireRecordSchema,
} from "./fixtures.js";
import type { WireRecord, WireValue } from "./fixtures.js";

const event = (value: WireValue) => `data: ${JSON.stringify(value)}\n\n`;

const StringValueSchema = Type.String();
const TypeTaggedSchema = Type.Object({ type: Type.String() });

const requestJson = (body: RequestInit["body"], headers: Headers): WireRecord => {
  if (Value.Check(StringValueSchema, body)) {
    return wireRecord(JSON.parse(body));
  }
  if (!(body instanceof Uint8Array)) {
    throw new Error("Unexpected request body");
  }
  const bytes = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(body) : body;
  return wireRecord(JSON.parse(new TextDecoder().decode(bytes)));
};

const turnMetadata = (request: WireRecord) => {
  const metadata = Value.Check(WireRecordSchema, request.client_metadata)
    ? request.client_metadata
    : undefined;
  const value = metadata?.["x-codex-turn-metadata"];
  return Value.Check(StringValueSchema, value) ? wireRecord(JSON.parse(value)) : undefined;
};

const inputItemTypes = (input: WireValue) =>
  Array.isArray(input)
    ? wireArray(input).flatMap((item) => (Value.Check(TypeTaggedSchema, item) ? [item.type] : []))
    : [];

const assistantText = (message: AssistantMessage) =>
  message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");

const assistantEvents = (id = "normal", inputTokens = 10) => {
  const message = {
    content: [
      {
        annotations: [],
        text: `assistant-${id}`,
        type: "output_text",
      },
    ],
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    type: "message",
  };
  return [
    {
      response: { id: `resp_${id}`, status: "in_progress" },
      type: "response.created",
    },
    {
      item: {
        content: [],
        id: message.id,
        role: "assistant",
        status: "in_progress",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    },
    {
      content_index: 0,
      delta: `assistant-${id}`,
      output_index: 0,
      type: "response.output_text.delta",
    },
    {
      item: message,
      output_index: 0,
      type: "response.output_item.done",
    },
    {
      response: {
        id: `resp_${id}`,
        output: [message],
        status: "completed",
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: inputTokens + 2,
        },
      },
      type: "response.completed",
    },
  ];
};

const assistantResponse = (id = "normal", inputTokens = 10) =>
  new Response(assistantEvents(id, inputTokens).map(event).join(""), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });

const interruptedAssistantResponse = (id: string, text: string) => {
  const bytes = new TextEncoder().encode(
    [
      event({
        response: { id: `resp_${id}`, status: "in_progress" },
        type: "response.created",
      }),
      event({
        item: {
          content: [],
          id: `msg_${id}`,
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.added",
      }),
      event({
        content_index: 0,
        delta: text,
        output_index: 0,
        type: "response.output_text.delta",
      }),
    ].join(""),
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
        controller.error(new Error("fetch failed after partial output"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

const compactResponse = (id = "compact") => {
  const compaction = {
    encrypted_content: `opaque-${id}`,
    id: `cmp_${id}`,
    type: "compaction",
  };
  return new Response(
    [
      event({
        response: { id: `resp_${id}`, status: "in_progress" },
        type: "response.created",
      }),
      event({
        item: compaction,
        output_index: 0,
        type: "response.output_item.done",
      }),
      event({
        response: {
          id: `resp_${id}`,
          output: [compaction],
          status: "completed",
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 23,
          },
        },
        type: "response.completed",
      }),
    ].join(""),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  );
};

const toolCallResponse = (id = "tool", name = "large_result") => {
  const item = {
    arguments: "{}",
    call_id: `call_${id}`,
    id: `fc_${id}`,
    name,
    status: "completed",
    type: "function_call",
  };
  return new Response(
    [
      event({
        response: { id: `resp_${id}`, status: "in_progress" },
        type: "response.created",
      }),
      event({
        item: { ...item, status: "in_progress" },
        output_index: 0,
        type: "response.output_item.added",
      }),
      event({
        item,
        output_index: 0,
        type: "response.output_item.done",
      }),
      event({
        response: {
          id: `resp_${id}`,
          output: [item],
          status: "completed",
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 110,
          },
        },
        type: "response.completed",
      }),
    ].join(""),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  );
};

const overflowResponse = () =>
  new Response(
    event({
      response: {
        error: {
          code: "context_length_exceeded",
          message: "Maximum context length exceeded",
        },
        id: "resp_overflow",
        status: "failed",
      },
      type: "response.failed",
    }),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  );

const malformedCompactResponse = () =>
  new Response(
    event({
      response: { id: "resp_malformed", status: "completed" },
      type: "response.completed",
    }),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  );

const workspace = async (prefix: string) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const cwd = path.join(rootDir, "project");
  const sessionDir = path.join(rootDir, "sessions");
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(rootDir, "agent-config"));
  await mkdir(cwd, { recursive: true });
  return { cwd, rootDir, sessionDir };
};

const addEnvelopeFields: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (providerEvent) => ({
    ...wireRecord(providerEvent.payload),
    client_metadata: { phase: "three" },
    service_tier: "priority",
  }));
};

const responsesLiteTransform: ExtensionFactory = (pi) => {
  pi.on("before_provider_headers", (headerEvent) => {
    headerEvent.headers["x-openai-internal-codex-responses-lite"] = "true";
  });
  pi.on("before_provider_request", (providerEvent) => {
    const payload = wireRecord(providerEvent.payload);
    if (!Array.isArray(payload.input)) {
      return;
    }
    const input = payload.input.map((item) => {
      if (!Value.Check(WireRecordSchema, item) || !Array.isArray(item.content)) {
        return item;
      }
      return {
        ...item,
        content: item.content.map((content) => {
          if (!Value.Check(WireRecordSchema, content) || content.type !== "input_image") {
            return content;
          }
          const { detail: _detail, ...image } = content;
          return image;
        }),
      };
    });
    const { instructions, tools, ...rest } = payload;
    const prefix: WireRecord[] = [
      {
        role: "developer",
        tools: Array.isArray(tools) ? tools : [],
        type: "additional_tools",
      },
    ];
    if (Value.Check(StringValueSchema, instructions) && instructions.length > 0) {
      prefix.push({
        content: [{ text: instructions, type: "input_text" }],
        role: "developer",
        type: "message",
      });
    }
    return { ...rest, input: [...prefix, ...input], instructions: "" };
  });
};

type ContextTokenCapture = {
  value?: number;
};

const addOneLargePayloadOnlyMessage =
  (observedContextTokens: ContextTokenCapture): ExtensionFactory =>
  (pi) => {
    let injected = false;
    pi.on("context", (_event, ctx) => {
      const tokens = ctx.getContextUsage()?.tokens;
      if (observedContextTokens.value === undefined && tokens !== null && tokens !== undefined) {
        observedContextTokens.value = tokens;
      }
    });
    pi.on("before_provider_request", (providerEvent) => {
      const payload = wireRecord(providerEvent.payload);
      if (injected) {
        return {
          ...payload,
          client_metadata: { phase: "four" },
        };
      }
      injected = true;
      return {
        ...payload,
        client_metadata: { phase: "four" },
        input: [
          ...wireArray(payload.input),
          {
            content: [
              {
                text: `payload-only:${"p".repeat(300_000)}`,
                type: "input_text",
              },
            ],
            role: "user",
            type: "message",
          },
        ],
      };
    });
  };

const surroundContext: ExtensionFactory = (pi) => {
  pi.on("context", (contextEvent) => ({
    messages: [
      {
        content: "earlier-context-prefix",
        role: "user",
        timestamp: Date.now(),
      },
      ...contextEvent.messages,
      {
        content: "earlier-context-suffix",
        role: "user",
        timestamp: Date.now(),
      },
    ],
  }));
};

const replaceContextWhen =
  (enabled: () => boolean): ExtensionFactory =>
  (pi) => {
    pi.on("context", () =>
      enabled()
        ? {
            messages: [
              {
                content: `replacement-context:${"r".repeat(15_000)}`,
                role: "user",
                timestamp: Date.now(),
              },
            ],
          }
        : undefined,
    );
  };

const replaceContext = replaceContextWhen(() => true);

const addExistingFeatureHeader: ExtensionFactory = (pi) => {
  pi.on("before_provider_headers", (headerEvent) => {
    headerEvent.headers["X-Codex-Beta-Features"] = "existing_one, REMOTE_COMPACTION_V2";
  });
};

const addMalformedSentinel: ExtensionFactory = (pi) => {
  pi.on("context", (contextEvent) => ({
    messages: [
      ...contextEvent.messages,
      {
        content: [{ text: `${FRAME_MARKER_PREFIX}bogus]`, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      },
    ],
  }));
};

const duplicateCurrentMarker: ExtensionFactory = (pi) => {
  pi.on("context", (contextEvent) => {
    const marker = contextEvent.messages.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (content) =>
            content.type === "text" && content.text.startsWith(`${FRAME_MARKER_PREFIX}start:`),
        ),
    );
    return marker ? { messages: [...contextEvent.messages, structuredClone(marker)] } : undefined;
  });
};

const injectCustomMessageWithPersistedTimestampDrift =
  (enabled: () => boolean): ExtensionFactory =>
  (pi) => {
    pi.on("before_agent_start", () =>
      enabled()
        ? {
            message: {
              content: "timestamp drift",
              customType: "test-timestamp-drift",
              display: false,
            },
          }
        : undefined,
    );
    pi.on("message_start", (messageEvent) => {
      if (
        messageEvent.message.role === "custom" &&
        messageEvent.message.customType === "test-timestamp-drift"
      ) {
        vi.setSystemTime("2026-08-03T12:00:01.000Z");
      }
    });
  };

const mutateBranchBeforeSecondProviderRequest: ExtensionFactory = (pi) => {
  let requests = 0;
  pi.on("before_provider_request", () => {
    requests += 1;
    if (requests === 2) {
      pi.appendEntry("test-replay-race", {
        changed: true,
      });
    }
  });
};

const mutateBranchAndAddLargePayload: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (providerEvent) => {
    pi.appendEntry("test-candidate-race", { changed: true });
    const payload = wireRecord(providerEvent.payload);
    return {
      ...payload,
      input: [
        ...wireArray(payload.input),
        {
          content: [
            {
              text: "r".repeat(16_000),
              type: "input_text",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
    };
  });
};

const prependSplitToolCallWhen =
  (enabled: () => boolean): ExtensionFactory =>
  (pi) => {
    pi.on("context", (contextEvent) =>
      enabled()
        ? {
            messages: [
              {
                api: SPIKE_MODEL.api,
                content: [
                  {
                    arguments: { path: "split.txt" },
                    id: "call_split|fc_split",
                    name: "read_file",
                    type: "toolCall",
                  },
                ],
                model: SPIKE_MODEL.id,
                provider: SPIKE_MODEL.provider,
                role: "assistant",
                stopReason: "toolUse",
                timestamp: Date.now(),
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
              ...contextEvent.messages,
            ],
          }
        : undefined,
    );
  };

const prependSplitToolCall = prependSplitToolCallWhen(() => true);

const stabilizeCodexRequest: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (providerEvent) => ({
    ...wireRecord(providerEvent.payload),
    prompt_cache_key: "stable-test-session",
  }));
};

interface HookObservations {
  contexts: string[];
  headers: string[];
  payloads: string[];
}

const observeProviderHooks =
  (observations: HookObservations): ExtensionFactory =>
  (pi) => {
    pi.on("context", (contextEvent) => {
      observations.contexts.push(JSON.stringify(contextEvent.messages));
    });
    pi.on("before_provider_request", (providerEvent) => {
      observations.payloads.push(JSON.stringify(providerEvent.payload));
    });
    pi.on("before_provider_headers", (headerEvent) => {
      observations.headers.push(JSON.stringify(headerEvent.headers));
    });
  };

const largeResultTool: ExtensionFactory = (pi) => {
  pi.registerTool({
    description: "Return a large result for compaction timing coverage",
    execute: async () => ({
      content: [{ text: "x".repeat(120_000), type: "text" }],
      details: {},
    }),
    label: "Large result",
    name: "large_result",
    parameters: Type.Object({}),
  });
};

const NON_CODEX_MODEL = {
  ...SPIKE_MODEL,
  api: "openai-responses",
  baseUrl: "https://api.openai.test/v1",
  id: "gpt-non-codex",
  name: "Non-Codex Responses",
  provider: "openai",
} satisfies Model<"openai-responses">;

describe("Codex lifecycle compaction with a real AgentSession", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows Codex provider status without changing the session", async () => {
    const paths = await workspace("codex-provider-status-");
    const manager = SessionManager.inMemory(paths.cwd);
    const notifications: { message: string; type?: string }[] = [];
    const session = await createRealCodexSession({
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        setStatus: () => null,
      }),
    });

    try {
      const before = manager.getEntries();
      await session.prompt("/codex-provider");

      expect(manager.getEntries()).toStrictEqual(before);
      expect(notifications).toStrictEqual([
        {
          message: expect.stringContaining(
            `Codex provider status\nSession: ${manager.getSessionId()}`,
          ),
          type: "info",
        },
      ]);
      expect(notifications[0]?.message).toContain(
        `Model: ${SPIKE_MODEL.provider}/${SPIKE_MODEL.id}`,
      );
      expect(notifications[0]?.message).toContain("Count: 0 current branch · 0 session");
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("preserves the built-in request body apart from canonical metadata and merges its feature header", async () => {
    const paths = await workspace("codex-inline-unchanged-");
    const bodies: Uint8Array[] = [];
    const headersSeen: Headers[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers);
      if (Value.Check(StringValueSchema, init?.body)) {
        bodies.push(new TextEncoder().encode(init.body));
      } else if (init?.body instanceof Uint8Array) {
        bodies.push(init.body);
      } else {
        throw new TypeError("Unexpected request body");
      }
      return assistantResponse(`unchanged-${bodies.length}`);
    });
    vi.stubGlobal("fetch", fetch);
    const baseline = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [stabilizeCodexRequest],
      rootDir: paths.rootDir,
      sessionManager: SessionManager.inMemory(paths.cwd),
      systemPrompt: "unchanged system",
    });
    const combined = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [
        stabilizeCodexRequest,
        addExistingFeatureHeader,
        codexCompactionExtension,
      ],
      rootDir: paths.rootDir,
      sessionManager: SessionManager.inMemory(paths.cwd),
      systemPrompt: "unchanged system",
    });

    try {
      await baseline.prompt("unchanged request");
      await combined.prompt("unchanged request");

      const baselineBody = requestJson(bodies[0], headersSeen[0]);
      const replacementBody = requestJson(bodies[1], headersSeen[1]);
      const { client_metadata: clientMetadata, ...compatibleBody } = replacementBody;
      expect(compatibleBody).toStrictEqual(baselineBody);
      expect(clientMetadata).toMatchObject({
        session_id: expect.any(String),
        thread_id: expect.any(String),
        turn_id: expect.any(String),
        "x-codex-turn-metadata": expect.any(String),
        "x-codex-window-id": expect.any(String),
      });
      expect(turnMetadata({ client_metadata: clientMetadata })).toMatchObject({
        request_kind: "turn",
      });
      expect({
        combinedFeatures: headersSeen[1].get("x-codex-beta-features"),
        fetches: fetch.mock.calls.length,
      }).toStrictEqual({
        combinedFeatures: "existing_one,REMOTE_COMPACTION_V2",
        fetches: 2,
      });
    } finally {
      baseline.dispose();
      combined.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("prewarms an unchanged request through a real AgentSession", async () => {
    const paths = await workspace("codex-agent-session-prewarm-");
    const frames: WireRecord[] = [];
    const AgentSessionWebSocket = function AgentSessionWebSocket() {
      const socket = Object.assign(new EventTarget(), {
        close: () => null,
        readyState: 1,
        send: (data: string) => {
          const frame = wireRecord(JSON.parse(data));
          frames.push(frame);
          const response =
            frame.generate === false
              ? new Response(
                  event({
                    response: { id: "resp_prewarm", status: "completed" },
                    type: "response.completed",
                  }),
                )
              : assistantResponse("agent-session-prewarm");
          void response.text().then((body) => {
            for (const line of body.split("\n\n")) {
              if (!line.startsWith("data: ")) {
                continue;
              }
              socket.dispatchEvent(new MessageEvent("message", { data: line.slice(6) }));
            }
          });
        },
      });
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", AgentSessionWebSocket);
    const fetch = vi.fn<FetchFunction>(async () => assistantResponse("unexpected-sse"));
    vi.stubGlobal("fetch", fetch);
    const session = await createRealCodexSession({
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: SessionManager.inMemory(paths.cwd),
      transport: "websocket",
    });

    try {
      await session.prompt("prewarm this request");

      expect({
        fetches: fetch.mock.calls.length,
        generate: frames.map((frame) => frame.generate),
        requestKinds: frames.map((frame) => turnMetadata(frame)?.request_kind),
      }).toStrictEqual({
        fetches: 0,
        generate: [false, undefined],
        requestKinds: ["prewarm", "turn"],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("leaves non-Codex hooks, transport, and session state untouched", async () => {
    const paths = await workspace("codex-inline-non-codex-");
    const before: HookObservations = {
      contexts: [],
      headers: [],
      payloads: [],
    };
    const after: HookObservations = {
      contexts: [],
      headers: [],
      payloads: [],
    };
    const networkRequests: WireRecord[] = [];
    const networkHeaders: Headers[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      networkHeaders.push(headers);
      networkRequests.push(requestJson(init?.body, headers));
      return assistantResponse("non-codex");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [
        observeProviderHooks(before),
        codexCompactionExtension,
        observeProviderHooks(after),
      ],
      model: NON_CODEX_MODEL,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "non-Codex system",
    });

    try {
      await session.prompt("non-Codex request");
      const branch = manager.getBranch();

      expect({
        contextUntouched: after.contexts,
        customEntries: branch.filter(
          (entry) => entry.type === "custom" || entry.type === "compaction",
        ).length,
        fetches: fetch.mock.calls.length,
        headerUntouched: after.headers,
        payloadUntouched: after.payloads,
        remoteFeature: networkHeaders[0]?.get("x-codex-beta-features"),
        requestMatchesPayload: JSON.stringify(networkRequests[0]) === after.payloads[0],
        roles: branch.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
      }).toStrictEqual({
        contextUntouched: before.contexts,
        customEntries: 0,
        fetches: 1,
        headerUntouched: before.headers,
        payloadUntouched: before.payloads,
        remoteFeature: null,
        requestMatchesPayload: true,
        roles: ["user", "assistant"],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("preserves unrelated malformed sentinel-like user text", async () => {
    const paths = await workspace("codex-inline-malformed-frame-");
    const notifications: string[] = [];
    const requests: WireRecord[] = [];
    const responses = [compactResponse("malformed-text"), assistantResponse("malformed-text")];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [addMalformedSentinel, codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("x".repeat(15_000));

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        preserved: requests.map((request) =>
          JSON.stringify(request).includes(`${FRAME_MARKER_PREFIX}bogus]`),
        ),
      }).toStrictEqual({
        active: "checkpoint",
        fetches: 2,
        notification: undefined,
        preserved: [true, true],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("aborts before fetch when a later context handler duplicates the current marker", async () => {
    const paths = await workspace("codex-inline-duplicate-frame-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>();
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension, duplicateCurrentMarker],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("x".repeat(15_000));

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        active: "none",
        fetches: 0,
        notification: "OpenAI checkpoint replay was blocked because request markers are invalid.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("records a diagnostic outside the session when active replay cannot frame context", async () => {
    const paths = await workspace("codex-active-frame-diagnostic-");
    const notifications: string[] = [];
    let ordinaryResponses = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("diagnostic");
      }
      return assistantResponse(`diagnostic-source-${(ordinaryResponses += 1)}`);
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.create(paths.cwd, paths.sessionDir);
    let replacementEnabled = false;
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [replaceContextWhen(() => replacementEnabled), codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("diagnostic source");
      await session.compact();
      replacementEnabled = true;
      await session.prompt("must fail closed");
      const observations = new CodexObservability(
        path.join(getExtensionStoragePaths("codex-provider").dataDir, "codex-provider.sqlite"),
      );
      const frameObservations = observations
        .list(manager.getSessionId())
        .filter((observation) => observation.kind === "context-frame-failure");
      observations.close();

      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        observationKinds: frameObservations.map((observation) => observation.kind),
      }).toStrictEqual({
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because request context could not be framed safely. A diagnostic was saved to the Codex provider database.",
        observationKinds: ["context-frame-failure"],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("replays an active checkpoint across before_agent_start custom-message timestamp drift", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-08-03T12:00:00.000Z");
    const paths = await workspace("codex-inline-custom-timestamp-drift-");
    const notifications: string[] = [];
    const requests: WireRecord[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const request = requestJson(init?.body, new Headers(init?.headers));
      requests.push(request);
      return inputItemTypes(request.input).includes("compaction_trigger")
        ? compactResponse("timestamp-drift")
        : assistantResponse(`timestamp-drift-${requests.length}`);
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    let injectCustomMessage = true;
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [
        injectCustomMessageWithPersistedTimestampDrift(() => injectCustomMessage),
        codexCompactionExtension,
      ],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("x".repeat(15_000));
      injectCustomMessage = false;
      await session.prompt("replay after timestamp drift");
      const replayInput = requests.at(-1)?.input;
      const serialized = JSON.stringify(replayInput);

      expect({
        fetches: fetch.mock.calls.length,
        markerAbsent: !serialized.includes(FRAME_MARKER_PREFIX),
        notification: notifications.at(-1),
        opaqueCount: inputItemTypes(replayInput).filter((type) => type === "compaction").length,
        requestTypes: requests.map((request) => inputItemTypes(request.input)),
      }).toStrictEqual({
        fetches: 4,
        markerAbsent: true,
        notification: undefined,
        opaqueCount: 1,
        requestTypes: [
          ["compaction_trigger"],
          ["message", "message", "compaction"],
          ["message", "message", "compaction", "message", "compaction_trigger"],
          ["message", "message", "message", "compaction"],
        ],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("replays after Pi omits an auto-retry error from live context", async () => {
    const paths = await workspace("codex-auto-retry-alignment-");
    let ordinaryRequests = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("retry-checkpoint");
      }
      ordinaryRequests += 1;
      if (ordinaryRequests === 2) {
        throw new TypeError("fetch failed");
      }
      return ordinaryRequests === 3
        ? toolCallResponse("retry-tool")
        : assistantResponse(ordinaryRequests === 1 ? "retry-seed" : "retry-final");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [largeResultTool, codexCompactionExtension],
      retry: {
        baseDelayMs: 1,
        enabled: true,
        maxRetries: 1,
        provider: { maxRetries: 0 },
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("retry alignment seed");
      await session.compact();
      await session.prompt("retry once, use large_result, then answer");
      const branch = manager.getBranch();

      expect({
        failedAssistants: branch.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "error",
        ).length,
        fetches: fetch.mock.calls.length,
        finalStopReason: session.messages.findLast((message) => message.role === "assistant")
          ?.stopReason,
      }).toStrictEqual({
        failedAssistants: 1,
        fetches: 5,
        finalStopReason: "stop",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("leaves a post-output provider failure to Pi's outer retry", async () => {
    const paths = await workspace("codex-outer-retry-partial-");
    const requests: WireRecord[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      requests.push(requestJson(init?.body, new Headers(init?.headers)));
      return requests.length === 1
        ? interruptedAssistantResponse("partial", "partial-before-retry")
        : assistantResponse("retry-clean");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      retry: {
        baseDelayMs: 1,
        enabled: true,
        maxRetries: 1,
        provider: { maxRetries: 1 },
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("retry after partial output");
      const persistedAssistants = manager
        .getBranch()
        .flatMap((branchEntry) =>
          branchEntry.type === "message" && branchEntry.message.role === "assistant"
            ? [branchEntry.message]
            : [],
        );
      const liveAssistants = session.messages.filter((message) => message.role === "assistant");

      expect({
        fetches: fetch.mock.calls.length,
        liveStops: liveAssistants.map((message) => message.stopReason),
        persistedStops: persistedAssistants.map((message) => message.stopReason),
        persistedText: persistedAssistants.map(assistantText),
        retryContext: JSON.stringify(requests[1]?.input),
        winningText: assistantText(liveAssistants[0]),
      }).toStrictEqual({
        fetches: 2,
        liveStops: ["stop"],
        persistedStops: ["error", "stop"],
        persistedText: ["partial-before-retry", "assistant-retry-clean"],
        retryContext: expect.not.stringContaining("partial-before-retry"),
        winningText: "assistant-retry-clean",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("outer-retries the incident WebSocket error after stream start", async () => {
    const paths = await workspace("codex-outer-retry-websocket-");
    const frames: WireRecord[] = [];
    let generatedAttempts = 0;
    let socketAttempts = 0;
    const IncidentWebSocket = function IncidentWebSocket() {
      socketAttempts += 1;
      const socket = Object.assign(new EventTarget(), {
        close: () => null,
        readyState: 1,
        send: (data: string) => {
          const frame = wireRecord(JSON.parse(data));
          frames.push(frame);
          generatedAttempts += 1;
          if (generatedAttempts === 1) {
            queueMicrotask(() =>
              socket.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    response: {
                      id: "resp_ws_outer_failure",
                      status: "in_progress",
                    },
                    type: "response.created",
                  }),
                }),
              ),
            );
            setTimeout(() => socket.dispatchEvent(new Event("error")), 0);
            return;
          }
          for (const responseEvent of assistantEvents("ws-outer-retry-clean")) {
            queueMicrotask(() =>
              socket.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify(responseEvent),
                }),
              ),
            );
          }
        },
      });
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", IncidentWebSocket);
    const fetch = vi.fn<FetchFunction>(async () => {
      throw new Error("unexpected SSE fallback");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      extensionFactories: [addEnvelopeFields, codexCompactionExtension],
      retry: {
        baseDelayMs: 1,
        enabled: true,
        maxRetries: 1,
        provider: { maxRetries: 5 },
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      transport: "websocket",
    });

    try {
      await session.prompt("retry the WebSocket incident");
      const persistedAssistants = manager
        .getBranch()
        .flatMap((branchEntry) =>
          branchEntry.type === "message" && branchEntry.message.role === "assistant"
            ? [branchEntry.message]
            : [],
        );
      const generatedFrames = frames.filter((frame) => frame.generate !== false);

      expect({
        errors: persistedAssistants.map((message) => message.errorMessage),
        fetches: fetch.mock.calls.length,
        generatedAttempts,
        persistedStops: persistedAssistants.map((message) => message.stopReason),
        retryContext: JSON.stringify(generatedFrames[1]?.input),
        socketAttempts,
        winningText: assistantText(persistedAssistants[1]),
      }).toStrictEqual({
        errors: ["WebSocket error: stream failed", undefined],
        fetches: 0,
        generatedAttempts: 2,
        persistedStops: ["error", "stop"],
        retryContext: expect.not.stringContaining("WebSocket error: stream failed"),
        socketAttempts: 2,
        winningText: "assistant-ws-outer-retry-clean",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("aborts the pending request when inline request state changes", async () => {
    const paths = await workspace("codex-inline-stale-state-");
    const notifications: string[] = [];
    const started = Promise.withResolvers<boolean>();
    const released = Promise.withResolvers<boolean>();
    const fetch = vi.fn<FetchFunction>(async () => {
      started.resolve(true);
      await released.promise;
      return compactResponse("stale-inline");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
        reasoning: true,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      const prompting = session.prompt("x".repeat(15_000));
      await started.promise;
      session.setThinkingLevel("high");
      manager.appendCustomEntry("test-race", { changed: true });
      released.resolve(true);
      await prompting;

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        active: "none",
        fetches: 1,
        notification:
          "OpenAI checkpoint input changed before completion; the result was discarded.",
      });
    } finally {
      released.resolve(true);
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("aborts when an inline checkpoint append cannot be verified", async () => {
    const paths = await workspace("codex-inline-append-failure-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>(async () => compactResponse("append-failure"));
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const actualGetBranch = manager.getBranch.bind(manager);
    let concealCheckpoint = true;
    Object.defineProperty(manager, "getBranch", {
      value: () => {
        const branch = actualGetBranch();
        const last = branch.at(-1);
        return concealCheckpoint &&
          last?.type === "custom" &&
          last.customType === CHECKPOINT_CUSTOM_TYPE
          ? branch.slice(0, -1)
          : branch;
      },
    });
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("x".repeat(15_000));
      concealCheckpoint = false;

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        customEntries: manager.getBranch().filter((entry) => entry.type === "custom").length,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        active: "checkpoint",
        customEntries: 1,
        fetches: 1,
        notification:
          "OpenAI checkpoint persistence could not be verified; the model request was cancelled.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("does not continue or invoke Pi compaction after inline remote failure", async () => {
    const paths = await workspace("codex-inline-remote-failure-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>(async () => malformedCompactResponse());
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("x".repeat(15_000));

      expect({
        compactions: manager.getBranch().filter((entry) => entry.type === "compaction").length,
        customEntries: manager.getBranch().filter((entry) => entry.type === "custom").length,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        compactions: 0,
        customEntries: 0,
        fetches: 1,
        notification: "OpenAI checkpoint generation failed; the model request was cancelled.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("persists native state across reload and blocks incompatible replay", async () => {
    const paths = await workspace("codex-lifecycle-manual-");
    const requests: WireRecord[] = [];
    const requestHeaders: Headers[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requestHeaders.push(headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("manual");
      }
      return assistantResponse(`manual-${requests.length}`);
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.create(paths.cwd, paths.sessionDir);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });
    let resumed: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;
    let incompatible: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;
    const notifications: string[] = [];

    try {
      await session.prompt("manual lifecycle source");
      await session.compact();

      const installed = resolveActiveCheckpointBoundary(manager.getBranch());
      const installedEntry =
        installed.kind === "checkpoint" ? manager.getEntry(installed.boundaryEntryId) : undefined;
      const sessionFile = manager.getSessionFile();
      if (
        installed.kind !== "checkpoint" ||
        installedEntry?.type !== "compaction" ||
        !sessionFile
      ) {
        throw new Error("Manual checkpoint was not installed");
      }
      session.dispose();

      const resumedManager = SessionManager.continueRecent(paths.cwd, paths.sessionDir);
      resumed = await createRealCodexSession({
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
        extensionFactories: [codexCompactionExtension],
        rootDir: paths.rootDir,
        sessionManager: resumedManager,
      });
      const reloaded = resolveActiveCheckpointBoundary(resumedManager.getBranch());
      resumedManager.branch(installed.boundaryEntryId);
      const branched = resolveActiveCheckpointBoundary(resumedManager.getBranch());
      resumed.dispose();
      resumed = undefined;
      const incompatibleManager = SessionManager.continueRecent(paths.cwd, paths.sessionDir);
      incompatible = await createRealCodexSession({
        compaction: { enabled: false },
        extensionFactories: [codexCompactionExtension],
        model: NON_CODEX_MODEL,
        rootDir: paths.rootDir,
        sessionManager: incompatibleManager,
        uiContext: mockUiContext({
          notify: (message: string) => notifications.push(message),
          setStatus: () => null,
        }),
      });
      await incompatible.prompt("must fail closed");
      const nativeRequestIndex = requests.findIndex((request) =>
        inputItemTypes(request.input).includes("compaction_trigger"),
      );

      expect({
        branchCheckpoint:
          branched.kind === "checkpoint" ? branched.checkpoint.response.id : undefined,
        compactionFeature: requestHeaders[nativeRequestIndex]?.get("x-codex-beta-features"),
        fetches: fetch.mock.calls.length,
        incompatibleNotification: notifications.at(-1),
        marker: installedEntry.summary,
        nativeUsage: installedEntry.usage,
        persistedUsage: installed.checkpoint.response.usage,
        reason: installed.checkpoint.reason,
        reloadCheckpoint:
          reloaded.kind === "checkpoint" ? reloaded.checkpoint.response.id : undefined,
        sameFile: resumedManager.getSessionFile() === sessionFile,
      }).toStrictEqual({
        branchCheckpoint: "resp_manual",
        compactionFeature: "remote_compaction_v2",
        fetches: 2,
        incompatibleNotification:
          "OpenAI checkpoint replay was blocked because active native context is unsafe.",
        marker: nativeCheckpointSummary(installed.checkpoint.runtime.currentWindowId),
        nativeUsage: {
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
          output: 3,
          totalTokens: 23,
        },
        persistedUsage: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 20,
          output: 3,
          totalTokens: 23,
        },
        reason: "manual",
        reloadCheckpoint: "resp_manual",
        sameFile: true,
      });
    } finally {
      session.dispose();
      resumed?.dispose();
      incompatible?.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("preserves the cached request prefix when compacting after resume", async () => {
    const paths = await workspace("codex-lifecycle-resume-cache-");
    const model = createToolsModel("gpt-5.6-terra", true);
    const requests: WireRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFunction>(async (_input, init) => {
        const request = requestJson(init?.body, new Headers(init?.headers));
        requests.push(request);
        return inputItemTypes(request.input).includes("compaction_trigger")
          ? compactResponse("resume-cache")
          : assistantResponse("resume-cache");
      }),
    );
    const manager = SessionManager.create(paths.cwd, paths.sessionDir);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      model,
      rootDir: paths.rootDir,
      sessionManager: manager,
    });
    let resumed: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;

    try {
      await session.prompt("cache prefix source");
      session.dispose();
      resumed = await createRealCodexSession({
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
        extensionFactories: [codexCompactionExtension],
        model,
        rootDir: paths.rootDir,
        sessionManager: SessionManager.continueRecent(paths.cwd, paths.sessionDir),
      });
      resumed.setActiveToolsByName(["bash", "read"]);
      await resumed.compact();

      const [ordinary, compact] = requests;
      if (!ordinary || !compact) {
        throw new Error("Expected an ordinary request and a compaction request");
      }
      const ordinaryInput = wireArray(ordinary.input);
      const compactInput = wireArray(compact.input);
      expect({
        inputPrefix:
          JSON.stringify(compactInput.slice(0, ordinaryInput.length)) ===
          JSON.stringify(ordinaryInput),
        instructions: compact.instructions === ordinary.instructions,
        key: compact.prompt_cache_key === ordinary.prompt_cache_key,
        tools: JSON.stringify(compact.tools) === JSON.stringify(ordinary.tools),
      }).toStrictEqual({
        inputPrefix: true,
        instructions: true,
        key: true,
        tools: true,
      });
    } finally {
      session.dispose();
      resumed?.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("keeps custom instructions out of native compaction and replay", async () => {
    const paths = await workspace("codex-inline-manual-replay-");
    const requests: WireRecord[] = [];
    const requestHeaders: Headers[] = [];
    let ordinaryResponses = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requestHeaders.push(headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("manual-replay");
      }
      ordinaryResponses += 1;
      return assistantResponse(`manual-replay-${ordinaryResponses}`);
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      const customInstructions = "CUSTOM_PORTABLE_FOCUS_SENTINEL";
      await session.prompt("manual replay older source");
      await session.prompt("manual replay split turn");
      await session.compact(customInstructions);
      await session.prompt("normal request after lifecycle");

      const nativeRequest = requests.find((request) =>
        inputItemTypes(request.input).includes("compaction_trigger"),
      );
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      if (active.kind !== "checkpoint") {
        throw new Error("Manual replay checkpoint was not installed");
      }
      const activeEntry = manager.getEntry(active.boundaryEntryId);
      const marker = nativeCheckpointSummary(active.checkpoint.runtime.currentWindowId);
      const replayInput = requests.at(-1)?.input;
      const serialized = JSON.stringify(replayInput);
      expect({
        beta: requestHeaders.at(-1)?.get("x-codex-beta-features"),
        compactedAssistantAbsent: !serialized.includes("assistant-manual-replay-1"),
        customInstructionCounts: {
          native: JSON.stringify(nativeRequest).split(customInstructions).length - 1,
          replay: serialized.split(customInstructions).length - 1,
        },
        fetches: fetch.mock.calls.length,
        marker: activeEntry?.type === "compaction" ? activeEntry.summary : undefined,
        markerAbsentFromReplay: !serialized.includes(marker),
        opaqueCount: inputItemTypes(replayInput).filter((type) => type === "compaction").length,
      }).toStrictEqual({
        beta: "remote_compaction_v2",
        compactedAssistantAbsent: true,
        customInstructionCounts: {
          native: 0,
          replay: 0,
        },
        fetches: 4,
        marker,
        markerAbsentFromReplay: true,
        opaqueCount: 1,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("aborts replay before fetch when an earlier payload handler mutates the framed branch", async () => {
    const paths = await workspace("codex-inline-replay-race-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("replay-race");
      }
      return assistantResponse("replay-race-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [mutateBranchBeforeSecondProviderRequest, codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("create replay race checkpoint");
      await session.compact();
      await session.prompt("must abort after branch mutation");

      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        raceEntries: manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "test-replay-race")
          .length,
      }).toStrictEqual({
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because session context changed after framing.",
        raceEntries: 1,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("blocks corrupt inline state after a native lifecycle boundary", async () => {
    const paths = await workspace("codex-inline-corrupt-after-native-");
    const notifications: string[] = [];
    const requests: WireRecord[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("corrupt-source");
      }
      return assistantResponse("corrupt-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("create native boundary");
      await session.compact();
      manager.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { version: 9 });
      expect(resolveActiveCheckpointBoundary(manager.getBranch()).kind).toBe("invalid-checkpoint");
      await session.prompt("must not pass corrupt state");

      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        opaqueCount: inputItemTypes(requests.at(-1)?.input).filter((type) => type === "compaction")
          .length,
      }).toStrictEqual({
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because active native context is unsafe.",
        opaqueCount: 0,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("retries an eligible previous-model compaction once with the current model", async () => {
    const paths = await workspace("codex-model-fallback-");
    const previousModel = {
      ...SPIKE_MODEL,
      contextWindow: 20_000,
      id: "gpt-5.6-previous",
      name: "Previous Codex",
    };
    const currentModel = {
      ...SPIKE_MODEL,
      contextWindow: 4000,
      id: "gpt-5.6-current",
      name: "Current Codex",
    };
    const requests: WireRecord[] = [];
    const responses = [
      assistantResponse("previous-turn"),
      overflowResponse(),
      compactResponse("current-fallback"),
      assistantResponse("current-turn"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: { enabled: false },
      extensionFactories: [codexCompactionExtension],
      model: previousModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("establish previous model history");
      await session.setModel(currentModel);
      await session.prompt(`force model downshift ${"x".repeat(16_000)}`);
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const metadata = requests.slice(1, 3).map(turnMetadata);

      expect({
        checkpointModel:
          active.kind === "checkpoint" ? active.checkpoint.identity.model : undefined,
        checkpointResponse:
          active.kind === "checkpoint" ? active.checkpoint.response.id : undefined,
        models: requests.map((request) => request.model),
        reasons: metadata.map((value) =>
          Value.Check(WireRecordSchema, value?.compaction) ? value.compaction.reason : undefined,
        ),
        triggers: requests.map((request) =>
          inputItemTypes(request.input).includes("compaction_trigger"),
        ),
      }).toStrictEqual({
        checkpointModel: "gpt-5.6-current",
        checkpointResponse: "resp_current-fallback",
        models: ["gpt-5.6-previous", "gpt-5.6-previous", "gpt-5.6-current", "gpt-5.6-current"],
        reasons: ["model_downshift", "model_downshift"],
        triggers: [false, true, true, false],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("compacts inline before pre-sampling and continues the pending request", async () => {
    const paths = await workspace("codex-inline-pre-sampling-");
    const thresholdModel = {
      ...SPIKE_MODEL,
      contextWindow: 4000,
      maxTokens: 1000,
    };
    const requests: WireRecord[] = [];
    const headersSeen: Headers[] = [];
    const responses = [
      compactResponse("inline-pre-sampling"),
      assistantResponse("inline-pre-sampling"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [surroundContext, addEnvelopeFields, codexCompactionExtension],
      model: thresholdModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt("x".repeat(15_000));
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const sideInput = requests[0]?.input;
      const normalInput = requests[1]?.input;
      const checkpointJson =
        active.kind === "checkpoint" ? JSON.stringify(active.checkpoint.replacement) : "";

      expect({
        active: {
          carrier: active.kind === "checkpoint" ? active.carrier : undefined,
          phase: active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
          response: active.kind === "checkpoint" ? active.checkpoint.response.id : undefined,
        },
        checkpointMutationCount: ["earlier-context-prefix", "earlier-context-suffix"].map(
          (value) => checkpointJson.split(value).length - 1,
        ),
        envelopeParity: requests.map((request) => ({
          compactionReason: Value.Check(WireRecordSchema, turnMetadata(request)?.compaction)
            ? wireRecord(turnMetadata(request)?.compaction).reason
            : undefined,
          phase: Value.Check(WireRecordSchema, request.client_metadata)
            ? request.client_metadata.phase
            : undefined,
          requestKind: turnMetadata(request)?.request_kind,
          serviceTier: request.service_tier,
        })),
        featureHeaders: headersSeen.map((headers) => headers.get("x-codex-beta-features")),
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-provider:frame"),
        ),
        normalOpaqueCount: inputItemTypes(normalInput).filter((type) => type === "compaction")
          .length,
        normalTrigger: inputItemTypes(normalInput).includes("compaction_trigger"),
        requestMutationCounts: requests.map((request) => {
          const json = JSON.stringify(request);
          return [
            json.split("earlier-context-prefix").length - 1,
            json.split("earlier-context-suffix").length - 1,
          ];
        }),
        sideTrigger: inputItemTypes(sideInput).at(-1) === "compaction_trigger",
      }).toStrictEqual({
        active: {
          carrier: "inline",
          phase: "pre-sampling",
          response: "resp_inline-pre-sampling",
        },
        checkpointMutationCount: [0, 0],
        envelopeParity: [
          {
            compactionReason: "context_limit",
            phase: "three",
            requestKind: "compaction",
            serviceTier: "priority",
          },
          {
            compactionReason: undefined,
            phase: "three",
            requestKind: undefined,
            serviceTier: "priority",
          },
        ],
        featureHeaders: ["remote_compaction_v2", "remote_compaction_v2"],
        fetches: 2,
        markerLeak: false,
        normalOpaqueCount: 1,
        normalTrigger: false,
        requestMutationCounts: [
          [1, 1],
          [1, 1],
        ],
        sideTrigger: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("recompacts recoverable inline history after the endpoint changes", async () => {
    const paths = await workspace("codex-inline-endpoint-change-");
    const initialModel = {
      ...SPIKE_MODEL,
      contextWindow: 4000,
      maxTokens: 1000,
    };
    const changedModel = {
      ...initialModel,
      baseUrl: "https://changed-endpoint.invalid/backend-api",
      id: "gpt-5.6-changed-endpoint",
      name: "Changed endpoint Codex",
    };
    const notifications: string[] = [];
    const requests: WireRecord[] = [];
    const responses = [
      compactResponse("inline-old-endpoint"),
      assistantResponse("inline-old-endpoint"),
      compactResponse("lifecycle-new-endpoint"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      requests.push(requestJson(init?.body, new Headers(init?.headers)));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      model: initialModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt(`INLINE_LOCAL_HISTORY ${"x".repeat(15_000)}`);
      const inline = resolveActiveCheckpointBoundary(manager.getBranch());
      await session.setModel(changedModel);
      await session.compact();
      const recovered = resolveActiveCheckpointBoundary(manager.getBranch());
      const recoveryInput = JSON.stringify(requests.at(-1)?.input);

      expect({
        fetches: fetch.mock.calls.length,
        initialCarrier: inline.kind === "checkpoint" ? inline.carrier : undefined,
        localHistory: recoveryInput.includes("INLINE_LOCAL_HISTORY"),
        oldOpaqueState: recoveryInput.includes("opaque-inline-old-endpoint"),
        recovered:
          recovered.kind === "checkpoint"
            ? {
                baseUrl: recovered.checkpoint.identity.baseUrl,
                carrier: recovered.carrier,
                response: recovered.checkpoint.response.id,
              }
            : undefined,
        warning: notifications.includes(
          "An unusable inline OpenAI checkpoint was ignored because authoritative Pi context is still available.",
        ),
      }).toStrictEqual({
        fetches: 3,
        initialCarrier: "inline",
        localHistory: true,
        oldOpaqueState: false,
        recovered: {
          baseUrl: changedModel.baseUrl,
          carrier: "lifecycle",
          response: "resp_lifecycle-new-endpoint",
        },
        warning: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("normalizes provider image detail before checkpoint persistence", async () => {
    const paths = await workspace("codex-inline-image-detail-");
    const imageModel: Model<"openai-codex-responses"> = {
      ...SPIKE_MODEL,
      contextWindow: 4000,
      input: ["text", "image"],
      maxTokens: 1000,
    };
    const requests: WireRecord[] = [];
    const responses = [compactResponse("image-detail"), assistantResponse("image-detail")];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      requests.push(requestJson(init?.body, new Headers(init?.headers)));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: { enabled: false },
      extensionFactories: [codexCompactionExtension],
      model: imageModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt("x".repeat(15_000), {
        images: [{ data: "AA", mimeType: "image/png", type: "image" }],
      });
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      if (active.kind !== "checkpoint") {
        throw new Error("Image checkpoint was not installed");
      }
      const checkpointJson = JSON.stringify(active.checkpoint.replacement);
      const requestJsons = requests.map((request) => JSON.stringify(request.input));

      expect({
        checkpointDetail: checkpointJson.includes('"detail"'),
        checkpointImage: checkpointJson.includes('"input_image"'),
        checkpointPlaceholder: checkpointJson.includes(
          "image content omitted from compacted history",
        ),
        fetches: fetch.mock.calls.length,
        requestDetails: requestJsons.map((request) => request.includes('"detail"')),
        requestImages: requestJsons.map((request) => request.includes('"input_image"')),
      }).toStrictEqual({
        checkpointDetail: false,
        checkpointImage: false,
        checkpointPlaceholder: true,
        fetches: 2,
        requestDetails: [true, false],
        requestImages: [true, true],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("preserves paired payload headers and replay-safe images after transformation", async () => {
    const paths = await workspace("codex-inline-transformed-request-");
    const imageModel: Model<"openai-codex-responses"> = {
      ...SPIKE_MODEL,
      contextWindow: 4000,
      input: ["text", "image"],
      maxTokens: 1000,
    };
    const requests: WireRecord[] = [];
    const headersSeen: Headers[] = [];
    const responses = [
      compactResponse("transformed-request"),
      assistantResponse("transformed-request"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [responsesLiteTransform, codexCompactionExtension],
      model: imageModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt("x".repeat(15_000), {
        images: [{ data: "AA", mimeType: "image/png", type: "image" }],
      });
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      if (active.kind !== "checkpoint") {
        throw new Error("Transformed checkpoint was not installed");
      }
      const checkpointJson = JSON.stringify(active.checkpoint.replacement);
      const requestJsons = requests.map((request) => JSON.stringify(request.input));

      expect({
        checkpointDetail: checkpointJson.includes('"detail"'),
        checkpointImage: checkpointJson.includes('"input_image"'),
        checkpointPlaceholder: checkpointJson.includes(
          "image content omitted from compacted history",
        ),
        checkpointVersion: active.checkpoint.version,
        fetches: fetch.mock.calls.length,
        liteHeaders: headersSeen.map((headers) =>
          headers.get("x-openai-internal-codex-responses-lite"),
        ),
        requestDetails: requestJsons.map((request) => request.includes('"detail"')),
        requestImages: requestJsons.map((request) => request.includes('"input_image"')),
        requestPrefixes: requests.map(
          (request) =>
            Array.isArray(request.input) &&
            Value.Check(WireRecordSchema, request.input[0]) &&
            request.input[0].type,
        ),
      }).toStrictEqual({
        checkpointDetail: false,
        checkpointImage: false,
        checkpointPlaceholder: true,
        checkpointVersion: 1,
        fetches: 2,
        liteHeaders: ["true", "true"],
        requestDetails: [false, false],
        requestImages: [true, true],
        requestPrefixes: ["additional_tools", "additional_tools"],
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("compacts a pending user turn from fresh provider usage", async () => {
    const paths = await workspace("codex-inline-fresh-usage-");
    const responses = [
      assistantResponse("high-usage", 3700),
      compactResponse("fresh-usage"),
      assistantResponse("after-fresh-usage"),
    ];
    const fetch = vi.fn<FetchFunction>(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt("fill");
      expect(resolveActiveCheckpointBoundary(manager.getBranch()).kind).toBe("none");

      await session.prompt("trigger");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());

      expect({
        fetches: fetch.mock.calls.length,
        phase: active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
        response: active.kind === "checkpoint" ? active.checkpoint.response.id : undefined,
      }).toStrictEqual({
        fetches: 3,
        phase: "pre-sampling",
        response: "resp_fresh-usage",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("compacts the finalized payload when an earlier context hook replaces the baseline", async () => {
    const paths = await workspace("codex-inline-replaced-context-");
    const requests: WireRecord[] = [];
    const responses = [compactResponse("replaced-context"), assistantResponse("replaced-context")];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [replaceContext, codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt(`original-context:${"x".repeat(15_000)}`);
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const sideInput = requests[0]?.input;

      expect({
        active: active.kind,
        fetches: fetch.mock.calls.length,
        originalAbsent: !JSON.stringify(sideInput).includes("original-context"),
        replacementPresent: JSON.stringify(sideInput).includes("replacement-context"),
        trigger: inputItemTypes(sideInput).at(-1) === "compaction_trigger",
      }).toStrictEqual({
        active: "checkpoint",
        fetches: 2,
        originalAbsent: true,
        replacementPresent: true,
        trigger: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("compacts a finalized payload-only threshold crossing without marker framing", async () => {
    const paths = await workspace("codex-inline-payload-only-");
    const thresholdModel = {
      ...SPIKE_MODEL,
      contextWindow: 80_000,
      maxTokens: 1000,
    };
    const contextTokens: ContextTokenCapture = {};
    const requests: WireRecord[] = [];
    const responses = [
      compactResponse("payload-only"),
      assistantResponse("payload-only-pending"),
      assistantResponse("payload-only-replay"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [addOneLargePayloadOnlyMessage(contextTokens), codexCompactionExtension],
      model: thresholdModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt("payload-only threshold source");
      await session.prompt("replay payload-only checkpoint");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const sideInput = requests[0]?.input;
      const pendingInput = requests[1]?.input;
      const replayInput = requests[2]?.input;

      expect({
        active: {
          carrier: active.kind === "checkpoint" ? active.carrier : undefined,
          phase: active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
          response: active.kind === "checkpoint" ? active.checkpoint.response.id : undefined,
        },
        contextWasBelowThreshold: contextTokens.value !== undefined && contextTokens.value < 72_000,
        envelopePreserved: requests.map((request) => ({
          phase: Value.Check(WireRecordSchema, request.client_metadata)
            ? request.client_metadata.phase
            : undefined,
          requestKind: turnMetadata(request)?.request_kind,
        })),
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-provider:frame"),
        ),
        payloadOnlyPreserved: [sideInput, pendingInput, replayInput].every((input) =>
          JSON.stringify(input).includes("payload-only:"),
        ),
        pendingOpaque: inputItemTypes(pendingInput).filter((type) => type === "compaction").length,
        replayOpaque: inputItemTypes(replayInput).filter((type) => type === "compaction").length,
        sideTrigger: inputItemTypes(sideInput).at(-1) === "compaction_trigger",
      }).toStrictEqual({
        active: {
          carrier: "inline",
          phase: "pre-sampling",
          response: "resp_payload-only",
        },
        contextWasBelowThreshold: true,
        envelopePreserved: [
          { phase: "four", requestKind: "compaction" },
          { phase: "four", requestKind: undefined },
          { phase: "four", requestKind: undefined },
        ],
        fetches: 3,
        markerLeak: false,
        payloadOnlyPreserved: true,
        pendingOpaque: 1,
        replayOpaque: 1,
        sideTrigger: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("keeps Responses Lite tools and instructions for a post-compaction tool call", async () => {
    const paths = await workspace("codex-inline-lite-tool-");
    const contextTokens: ContextTokenCapture = {};
    const requests: WireRecord[] = [];
    const responses = [
      compactResponse("lite-tool"),
      toolCallResponse("lite-tool", "post_compaction_probe"),
      assistantResponse("lite-tool-final"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const probeCheckpointCounts: number[] = [];
    const postCompactionProbe: ExtensionFactory = (pi) => {
      pi.registerTool({
        description: "Confirm tools remain available after compaction",
        execute: async () => {
          probeCheckpointCounts.push(
            manager
              .getBranch()
              .filter(
                (entry) => entry.type === "custom" && entry.customType === CHECKPOINT_CUSTOM_TYPE,
              ).length,
          );
          return {
            content: [{ text: "post-compaction probe complete", type: "text" }],
            details: {},
          };
        },
        label: "Post-compaction probe",
        name: "post_compaction_probe",
        parameters: Type.Object({}),
      });
    };
    const systemPrompt =
      "POST_COMPACTION_SYSTEM_SENTINEL: use post_compaction_probe when requested.";
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [
        responsesLiteTransform,
        addOneLargePayloadOnlyMessage(contextTokens),
        postCompactionProbe,
        codexCompactionExtension,
      ],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 80_000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt,
    });

    try {
      await session.prompt("Run the post-compaction probe");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const [, pending] = requests;
      const pendingInput = Array.isArray(pending?.input) ? pending.input : [];
      const additionalTools = pendingInput.find(
        (item): item is WireRecord =>
          Value.Check(WireRecordSchema, item) && item.type === "additional_tools",
      );
      const developerMessage = pendingInput.find(
        (item) =>
          Value.Check(WireRecordSchema, item) &&
          item.type === "message" &&
          item.role === "developer",
      );
      const toolNames = Array.isArray(additionalTools?.tools)
        ? additionalTools.tools.flatMap((tool) =>
            Value.Check(WireRecordSchema, tool) && Value.Check(StringValueSchema, tool.name)
              ? [tool.name]
              : [],
          )
        : [];
      const checkpointJson =
        active.kind === "checkpoint" ? JSON.stringify(active.checkpoint.replacement) : "";

      expect({
        checkpoint: active.kind,
        checkpointHasRequestState:
          checkpointJson.includes("post_compaction_probe") ||
          checkpointJson.includes("POST_COMPACTION_SYSTEM_SENTINEL"),
        developerInstruction: JSON.stringify(developerMessage).includes(
          "POST_COMPACTION_SYSTEM_SENTINEL",
        ),
        fetches: fetch.mock.calls.length,
        pendingOpaque: inputItemTypes(pendingInput).filter((type) => type === "compaction").length,
        pendingPrefix: inputItemTypes(pendingInput).slice(0, 2),
        probeCheckpointCounts,
        toolAvailable: toolNames.includes("post_compaction_probe"),
        topLevelTools: pending?.tools,
      }).toStrictEqual({
        checkpoint: "checkpoint",
        checkpointHasRequestState: false,
        developerInstruction: true,
        fetches: 3,
        pendingOpaque: 1,
        pendingPrefix: ["additional_tools", "message"],
        probeCheckpointCounts: [1],
        toolAvailable: true,
        topLevelTools: undefined,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("blocks an unframed threshold candidate after a payload-stage branch race", async () => {
    const paths = await workspace("codex-inline-payload-race-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>(async () => {
      throw new Error("Unexpected fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [mutateBranchAndAddLargePayload, codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("candidate race");
      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        raceEntries: manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "test-candidate-race")
          .length,
      }).toStrictEqual({
        fetches: 0,
        notification:
          "OpenAI inline compaction was blocked because session context changed after context preparation.",
        raceEntries: 1,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("falls back to an unframed threshold candidate when a marker splits a tool pair", async () => {
    const paths = await workspace("codex-inline-tool-split-");
    const requests: WireRecord[] = [];
    const responses = [compactResponse("tool-split"), assistantResponse("tool-split-pending")];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    manager.appendMessage({
      content: [
        {
          text: `REAL_SPLIT_RESULT:${"r".repeat(15_000)}`,
          type: "text",
        },
      ],
      isError: false,
      role: "toolResult",
      timestamp: Date.now(),
      toolCallId: "call_split",
      toolName: "read_file",
    });
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [prependSplitToolCall, codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
    });

    try {
      await session.prompt("tool split threshold");
      const side = JSON.stringify(requests[0]);

      expect({
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-provider:frame"),
        ),
        realResultPreserved: side.includes("REAL_SPLIT_RESULT"),
        syntheticResultAbsent: !side.includes("No result provided"),
        trigger: inputItemTypes(requests[0]?.input).includes("compaction_trigger"),
      }).toStrictEqual({
        fetches: 2,
        markerLeak: false,
        realResultPreserved: true,
        syntheticResultAbsent: true,
        trigger: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("blocks active replay when a marker would split a tool pair", async () => {
    const paths = await workspace("codex-inline-active-tool-split-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("active-tool-split");
      }
      return assistantResponse("active-tool-split-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    let splitEnabled = false;
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [prependSplitToolCallWhen(() => splitEnabled), codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("create active tool-split checkpoint");
      await session.compact();
      splitEnabled = true;
      await session.agent.prompt({
        content: [{ text: "real active split result", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: Date.now(),
        toolCallId: "call_split",
        toolName: "read_file",
      });

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        active: "checkpoint",
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because marker framing changed the serialized request.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("compacts inline between tool-loop model calls and records mid-turn", async () => {
    const paths = await workspace("codex-inline-mid-turn-");
    const toolLoopModel = {
      ...SPIKE_MODEL,
      contextWindow: 30_000,
      maxTokens: 2000,
    };
    const requests: WireRecord[] = [];
    const responses = [
      toolCallResponse("mid-turn"),
      compactResponse("mid-turn"),
      assistantResponse("mid-turn-final"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [largeResultTool, codexCompactionExtension],
      model: toolLoopModel,
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "Use the large_result tool once, then answer.",
    });

    try {
      await session.prompt("Run the large result tool");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const sideInput = requests[1]?.input;
      const continuationInput = requests[2]?.input;

      expect({
        continuationOpaqueCount: inputItemTypes(continuationInput).filter(
          (type) => type === "compaction",
        ).length,
        continuationToolOutput: JSON.stringify(continuationInput).includes("function_call_output"),
        fetches: fetch.mock.calls.length,
        phase: active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
        sideTrigger: inputItemTypes(sideInput).includes("compaction_trigger"),
      }).toStrictEqual({
        continuationOpaqueCount: 1,
        continuationToolOutput: false,
        fetches: 3,
        phase: "mid-turn",
        sideTrigger: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("replaces repeated inline opaque state and replays it after resume and branch", async () => {
    const paths = await workspace("codex-inline-repeated-");
    const repeatModel = {
      ...SPIKE_MODEL,
      contextWindow: 30_000,
      maxTokens: 2000,
    };
    const requests: WireRecord[] = [];
    const notifications: string[] = [];
    const extensionErrors: string[] = [];
    const responses = [
      toolCallResponse("repeat-first-tool"),
      compactResponse("repeat-first"),
      assistantResponse("repeat-first-final"),
      toolCallResponse("repeat-second-tool"),
      compactResponse("repeat-second"),
      assistantResponse("repeat-second-final"),
      assistantResponse("repeat-resume"),
      assistantResponse("repeat-branch"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push(requestJson(init?.body, headers));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.create(paths.cwd, paths.sessionDir);
    const session = await createRealCodexSession({
      compaction: {
        enabled: false,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [largeResultTool, codexCompactionExtension],
      model: repeatModel,
      onExtensionError: (error) => extensionErrors.push(error.error),
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "Use large_result when requested.",
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });
    let resumed: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;

    try {
      await session.prompt("Run large_result for first checkpoint");
      await session.prompt("Run large_result for second checkpoint");
      const second = resolveActiveCheckpointBoundary(manager.getBranch());
      const sessionFile = manager.getSessionFile();
      if (second.kind !== "checkpoint" || !sessionFile) {
        throw new Error("Second inline checkpoint was not installed");
      }
      const secondPending = JSON.stringify(requests[5]?.input) ?? "";
      session.dispose();

      const resumedManager = SessionManager.open(sessionFile, paths.sessionDir);
      resumed = await createRealCodexSession({
        compaction: {
          enabled: false,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
        extensionFactories: [largeResultTool, codexCompactionExtension],
        model: repeatModel,
        rootDir: paths.rootDir,
        sessionManager: resumedManager,
        systemPrompt: "Use large_result when requested.",
      });
      await resumed.prompt("Resume without a tool");
      const resumedInput = JSON.stringify(requests[6]?.input) ?? "";
      await resumed.navigateTree(second.boundaryEntryId, { summarize: false });
      await resumed.prompt("Branch without a tool");
      const branchedInput = JSON.stringify(requests[7]?.input) ?? "";

      expect({
        branchReplay:
          branchedInput.includes("opaque-repeat-second") &&
          !branchedInput.includes("opaque-repeat-first"),
        extensionErrors,
        fetches: fetch.mock.calls.length,
        newestResponse: second.checkpoint.response.id,
        notifications,
        pendingReplaced:
          secondPending.includes("opaque-repeat-second") &&
          !secondPending.includes("opaque-repeat-first"),
        resumeReplay:
          resumedInput.includes("opaque-repeat-second") &&
          !resumedInput.includes("opaque-repeat-first"),
      }).toStrictEqual({
        branchReplay: true,
        extensionErrors: [],
        fetches: 8,
        newestResponse: "resp_repeat-second",
        notifications: [],
        pendingReplaced: true,
        resumeReplay: true,
      });
    } finally {
      session.dispose();
      resumed?.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("records the newest repeated lifecycle install without verification errors", async () => {
    const paths = await workspace("codex-lifecycle-repeated-");
    let nativeCompactions = 0;
    let ordinaryResponses = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        nativeCompactions += 1;
        return compactResponse(nativeCompactions === 1 ? "first" : "second");
      }
      ordinaryResponses += 1;
      return assistantResponse(ordinaryResponses === 1 ? "first-source" : "second-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const notifications: string[] = [];
    const compactEvents: SessionCompactEvent[] = [];
    const captureCompactions: ExtensionFactory = (pi) => {
      pi.on("session_compact", (compactEvent) => {
        compactEvents.push(compactEvent);
      });
    };
    const uiContext = mockUiContext({
      notify: (message: string) => notifications.push(message),
      setStatus: () => null,
    });
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [captureCompactions, codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext,
    });

    try {
      await session.prompt("first lifecycle source");
      await session.compact();
      const first = resolveActiveCheckpointBoundary(manager.getBranch());
      if (first.kind !== "checkpoint") {
        throw new Error("First lifecycle checkpoint was not installed");
      }

      await session.prompt("second lifecycle source");
      await session.compact();
      const newest = resolveActiveCheckpointBoundary(manager.getBranch());
      const eventResponses = compactEvents.map((compactEvent) => {
        const carrier = resolveCheckpointCarrier(compactEvent.compactionEntry);
        return carrier.kind === "checkpoint" ? carrier.checkpoint.response.id : carrier.kind;
      });
      expect({
        compactions: manager.getBranch().filter((entry) => entry.type === "compaction").length,
        eventResponses,
        eventSummaries: new Set(
          compactEvents.map((compactEvent) => compactEvent.compactionEntry.summary),
        ).size,
        fetches: fetch.mock.calls.length,
        installErrors: notifications.filter((message) =>
          message.includes("installation could not be verified"),
        ),
        newestResponse: newest.kind === "checkpoint" ? newest.checkpoint.response.id : undefined,
      }).toStrictEqual({
        compactions: 2,
        eventResponses: ["resp_first", "resp_second"],
        eventSummaries: 2,
        fetches: 4,
        installErrors: [],
        newestResponse: "resp_second",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("cancels overlapping lifecycle compactions without sharing a result", async () => {
    const paths = await workspace("codex-lifecycle-concurrent-");
    const sideRequestsStarted = Promise.withResolvers<null>();
    const pendingResponses: {
      readonly resolve: () => void;
    }[] = [];
    let sideRequests = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        sideRequests += 1;
        sideRequestsStarted.resolve(null);
        const pending = Promise.withResolvers<Response>();
        pendingResponses.push({
          resolve: () => pending.resolve(compactResponse("concurrent-native")),
        });
        const signal = init?.signal;
        const onAbort = () => {
          const error = new Error("aborted concurrent compaction");
          error.name = "AbortError";
          pending.reject(error);
        };
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener("abort", onAbort, { once: true });
        }
        return pending.promise;
      }
      return assistantResponse("concurrent-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const notifications: string[] = [];
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("concurrent lifecycle source");
      const first = session.compact("first instructions");
      await sideRequestsStarted.promise;
      const second = session.compact("second instructions");
      const settled = Promise.allSettled([first, second]);
      await delay(0);
      for (const pending of pendingResponses) {
        pending.resolve();
      }
      const results = await settled;

      expect({
        compactions: manager.getBranch().filter((entry) => entry.type === "compaction").length,
        notifications,
        reasons: results.map((result) =>
          result.status === "rejected" ? String(result.reason) : "fulfilled",
        ),
        sideRequests,
      }).toStrictEqual({
        compactions: 0,
        notifications: [],
        reasons: ["Error: Compaction cancelled", "Error: Compaction cancelled"],
        sideRequests: 1,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("holds the lifecycle lock until its matching compact event", async () => {
    const paths = await workspace("codex-lifecycle-install-lock-");
    const firstHookFinished = Promise.withResolvers<null>();
    const releaseFirstHook = Promise.withResolvers<null>();
    let beforeCompactEvents = 0;
    const delayFirstInstall: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", async () => {
        beforeCompactEvents += 1;
        if (beforeCompactEvents === 1) {
          firstHookFinished.resolve(null);
          await releaseFirstHook.promise;
        }
      });
    };
    let nativeCompactions = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        nativeCompactions += 1;
        return compactResponse(`install-lock-${nativeCompactions}`);
      }
      return assistantResponse("install-lock-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const notifications: string[] = [];
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension, delayFirstInstall],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("install lock source");
      const first = session.compact("first install");
      await firstHookFinished.promise;
      const second = session.compact("second install");
      const settled = Promise.allSettled([first, second]);
      await delay(0);
      releaseFirstHook.resolve(null);
      const results = await settled;

      expect({
        compactions: manager.getBranch().filter((entry) => entry.type === "compaction").length,
        installErrors: notifications.filter((message) =>
          message.includes("installation could not be verified"),
        ),
        nativeCompactions,
        statuses: results.map((result) => result.status),
      }).toStrictEqual({
        compactions: 0,
        installErrors: [],
        nativeCompactions: 1,
        statuses: ["rejected", "rejected"],
      });
    } finally {
      releaseFirstHook.resolve(null);
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("discards delayed compaction when active request state changes", async () => {
    const paths = await workspace("codex-lifecycle-request-state-");
    const delayed = Promise.withResolvers<Response>();
    const sideRequestStarted = Promise.withResolvers<null>();
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        sideRequestStarted.resolve(null);
        return delayed.promise;
      }
      return assistantResponse("state-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("request state source");
      if (session.getActiveToolNames().length === 0) {
        throw new Error("Fixture requires at least one active tool");
      }
      const before = manager.getBranch().map((branchEntry) => branchEntry.id);
      const compacting = session.compact();
      await sideRequestStarted.promise;
      session.setActiveToolsByName([]);
      delayed.resolve(compactResponse("state-stale"));

      await expect(compacting).rejects.toThrow("cancelled");
      expect({
        after: manager.getBranch().map((branchEntry) => branchEntry.id),
        before,
        compactions: manager.getBranch().filter((branchEntry) => branchEntry.type === "compaction")
          .length,
        fetches: fetch.mock.calls.length,
      }).toStrictEqual({
        after: before,
        before,
        compactions: 0,
        fetches: 2,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("cancels unavailable apiKey auth before invoking the provider", async () => {
    const paths = await workspace("codex-lifecycle-auth-");
    const fetch = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    manager.appendMessage({
      content: "auth-free lifecycle source",
      role: "user",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      api: SPIKE_MODEL.api,
      content: [{ text: "auth-free assistant", type: "text" }],
      model: SPIKE_MODEL.id,
      provider: SPIKE_MODEL.provider,
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
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
    });
    manager.appendMessage({
      content: "auth-free lifecycle tail",
      role: "user",
      timestamp: Date.now(),
    });
    const notifications: string[] = [];
    const uiContext = mockUiContext({
      notify: (message: string) => notifications.push(message),
      setStatus: () => null,
    });
    const session = await createRealCodexSession({
      apiKey: "",
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext,
    });

    try {
      await expect(session.compact()).rejects.toThrow("cancelled");
      expect({
        authErrors: notifications.filter((message) =>
          message.includes("authentication is unavailable"),
        ),
        compactions: manager.getBranch().filter((branchEntry) => branchEntry.type === "compaction")
          .length,
        fetches: fetch.mock.calls.length,
      }).toStrictEqual({
        authErrors: [
          "OpenAI remote compaction was cancelled because provider authentication is unavailable.",
        ],
        compactions: 0,
        fetches: 0,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("leaves the branch unchanged after native lifecycle failure", async () => {
    const paths = await workspace("codex-lifecycle-policy-");
    const notifications: string[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const request = requestJson(init?.body, new Headers(init?.headers));
      return inputItemTypes(request.input).includes("compaction_trigger")
        ? malformedCompactResponse()
        : assistantResponse("policy-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: mockUiContext({
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      }),
    });

    try {
      await session.prompt("policy source");
      const before = manager.getBranch().map((branchEntry) => branchEntry.id);
      await expect(session.compact()).rejects.toThrow("cancelled");
      const compactions = manager
        .getBranch()
        .filter((branchEntry) => branchEntry.type === "compaction");
      const after = manager.getBranch().map((branchEntry) => branchEntry.id);

      expect({
        branchUnchanged: JSON.stringify(after) === JSON.stringify(before),
        compactions: compactions.length,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        branchUnchanged: true,
        compactions: 0,
        fetches: 2,
        notification: "OpenAI compaction was cancelled; local context was left unchanged.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it.each(["threshold", "overflow"] as const)(
    "keeps context unchanged after $reason compaction failure",
    async (reason) => {
      const paths = await workspace("codex-lifecycle-automatic-policy-");
      let nativeCompactions = 0;
      let ordinaryRequests = 0;
      const fetch = vi.fn<FetchFunction>(async (_input, init) => {
        const request = requestJson(init?.body, new Headers(init?.headers));
        if (inputItemTypes(request.input).includes("compaction_trigger")) {
          nativeCompactions += 1;
          return malformedCompactResponse();
        }
        ordinaryRequests += 1;
        if (reason === "overflow" && ordinaryRequests === 2) {
          return overflowResponse();
        }
        return assistantResponse(`${reason}-turn-${ordinaryRequests}`);
      });
      vi.stubGlobal("fetch", fetch);
      const manager = SessionManager.inMemory(paths.cwd);
      const session = await createRealCodexSession({
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: reason === "threshold" ? SPIKE_MODEL.contextWindow - 5 : 1000,
        },
        extensionFactories: [codexCompactionExtension],
        rootDir: paths.rootDir,
        sessionManager: manager,
      });

      try {
        await session.prompt(`${reason} policy seed`);
        if (reason === "overflow") {
          await session.prompt("trigger overflow policy");
        }
        const compactions = manager
          .getBranch()
          .filter((branchEntry) => branchEntry.type === "compaction");
        expect({
          compactions: compactions.length,
          nativeCompactions,
          ordinaryRequests,
        }).toStrictEqual({
          compactions: 0,
          nativeCompactions: 1,
          ordinaryRequests: reason === "overflow" ? 2 : 1,
        });
      } finally {
        session.dispose();
        await rm(paths.rootDir, { force: true, recursive: true });
      }
    },
  );

  it("uses the native lifecycle result for Pi threshold compaction", async () => {
    const paths = await workspace("codex-lifecycle-threshold-");
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("threshold");
      }
      return assistantResponse("threshold");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: SPIKE_MODEL.contextWindow - 5,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("threshold lifecycle source");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const activeEntry =
        active.kind === "checkpoint" ? manager.getEntry(active.boundaryEntryId) : undefined;
      const marker =
        active.kind === "checkpoint"
          ? nativeCheckpointSummary(active.checkpoint.runtime.currentWindowId)
          : undefined;
      expect({
        carrier: active.kind === "checkpoint" ? active.carrier : undefined,
        fetches: fetch.mock.calls.length,
        fromHook: activeEntry?.type === "compaction" ? activeEntry.fromHook : undefined,
        marker: activeEntry?.type === "compaction" ? activeEntry.summary : undefined,
        reason: active.kind === "checkpoint" ? active.checkpoint.reason : undefined,
      }).toStrictEqual({
        carrier: "lifecycle",
        fetches: 2,
        fromHook: true,
        marker,
        reason: "threshold",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("lets Pi perform exactly one overflow retry after lifecycle success", async () => {
    const paths = await workspace("codex-lifecycle-overflow-");
    const requests: WireRecord[] = [];
    let ordinaryRequests = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("overflow");
      }
      ordinaryRequests += 1;
      return ordinaryRequests === 2
        ? overflowResponse()
        : assistantResponse(ordinaryRequests === 1 ? "seed" : "retry");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("seed overflow history");
      await session.prompt("overflow lifecycle source");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      const retryInput = requests.at(-1)?.input;
      expect({
        assistantStopReasons: session.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.stopReason),
        compactions: manager.getBranch().filter((entry) => entry.type === "compaction").length,
        fetches: fetch.mock.calls.length,
        opaqueCount: inputItemTypes(retryInput).filter((type) => type === "compaction").length,
        phase: active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
        reason: active.kind === "checkpoint" ? active.checkpoint.reason : undefined,
        retryHasTrigger: inputItemTypes(retryInput).includes("compaction_trigger"),
      }).toStrictEqual({
        assistantStopReasons: ["stop"],
        compactions: 1,
        fetches: 4,
        opaqueCount: 1,
        phase: "overflow-retry",
        reason: "overflow",
        retryHasTrigger: false,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });
});
