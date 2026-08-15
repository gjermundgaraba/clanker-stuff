import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type {
  AssistantMessage,
  FetchFunction,
  Model,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionFactory,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  resolveActiveCheckpointBoundary,
} from "../checkpoint.js";
import codexCompactionExtension from "../index.js";
import { CodexObservability } from "../observability.js";
import { FRAME_MARKER_PREFIX } from "../replay.js";
import { createRealCodexSession } from "./agent-session.js";
import { SPIKE_MODEL } from "./fixtures.js";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

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

const turnMetadata = (request: Record<string, unknown>) => {
  const metadata = request.client_metadata as
    | Record<string, unknown>
    | undefined;
  const value = metadata?.["x-codex-turn-metadata"];
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : undefined;
};

const inputItemTypes = (input: unknown) =>
  Array.isArray(input)
    ? input.flatMap((item) =>
        item && typeof item === "object" && "type" in item ? [item.type] : []
      )
    : [];

const assistantText = (message: AssistantMessage) =>
  message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("");

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
    ].join("")
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
    { headers: { "content-type": "text/event-stream" } }
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
    }
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
    }
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
    }
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
    }
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
    ...(providerEvent.payload as Record<string, unknown>),
    client_metadata: { phase: "three" },
    service_tier: "priority",
  }));
};

const responsesLiteTransform: ExtensionFactory = (pi) => {
  pi.on("before_provider_headers", (headerEvent) => {
    headerEvent.headers["x-openai-internal-codex-responses-lite"] = "true";
  });
  pi.on("before_provider_request", (providerEvent) => {
    const payload = providerEvent.payload as Record<string, unknown>;
    if (!Array.isArray(payload.input)) {
      return;
    }
    const input = payload.input.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("content" in item) ||
        !Array.isArray(item.content)
      ) {
        return item;
      }
      return {
        ...item,
        content: item.content.map((content: unknown) => {
          if (
            !content ||
            typeof content !== "object" ||
            !("type" in content) ||
            content.type !== "input_image"
          ) {
            return content;
          }
          const { detail: _detail, ...image } = content as Record<
            string,
            unknown
          >;
          return image;
        }),
      };
    });
    const { instructions, tools, ...rest } = payload;
    const prefix: Record<string, unknown>[] = [
      {
        role: "developer",
        tools: Array.isArray(tools) ? tools : [],
        type: "additional_tools",
      },
    ];
    if (typeof instructions === "string" && instructions.length > 0) {
      prefix.push({
        content: [{ text: instructions, type: "input_text" }],
        role: "developer",
        type: "message",
      });
    }
    return { ...rest, input: [...prefix, ...input], instructions: "" };
  });
};

const addOneLargePayloadOnlyMessage =
  (observedContextTokens: { value?: number }): ExtensionFactory =>
  (pi) => {
    let injected = false;
    pi.on("context", (_event, ctx) => {
      const tokens = ctx.getContextUsage()?.tokens;
      if (
        observedContextTokens.value === undefined &&
        tokens !== null &&
        tokens !== undefined
      ) {
        observedContextTokens.value = tokens;
      }
    });
    pi.on("before_provider_request", (providerEvent) => {
      const payload = providerEvent.payload as Record<string, unknown>;
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
          ...(payload.input as unknown[]),
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
        : undefined
    );
  };

const replaceContext = replaceContextWhen(() => true);

const addExistingFeatureHeader: ExtensionFactory = (pi) => {
  pi.on("before_provider_headers", (headerEvent) => {
    headerEvent.headers["X-Codex-Beta-Features"] =
      "existing_one, REMOTE_COMPACTION_V2";
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
            content.type === "text" &&
            content.text.startsWith(`${FRAME_MARKER_PREFIX}start:`)
        )
    );
    return marker
      ? { messages: [...contextEvent.messages, structuredClone(marker)] }
      : undefined;
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
        : undefined
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
    const payload = providerEvent.payload as Record<string, unknown>;
    return {
      ...payload,
      input: [
        ...(payload.input as unknown[]),
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
        : undefined
    );
  };

const prependSplitToolCall = prependSplitToolCallWhen(() => true);

const stabilizeCodexRequest: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (providerEvent) => ({
    ...(providerEvent.payload as Record<string, unknown>),
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
      uiContext: {
        notify: (message: string, type?: string) =>
          notifications.push({ message, type }),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      const before = manager.getEntries();
      await session.prompt("/codex-provider");

      expect(manager.getEntries()).toStrictEqual(before);
      expect(notifications).toStrictEqual([
        {
          message: expect.stringContaining(
            `Codex provider status\nSession: ${manager.getSessionId()}`
          ),
          type: "info",
        },
      ]);
      expect(notifications[0]?.message).toContain(
        `Model: ${SPIKE_MODEL.provider}/${SPIKE_MODEL.id}`
      );
      expect(notifications[0]?.message).toContain(
        "Count: 0 current branch · 0 session"
      );
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
      if (typeof init?.body === "string") {
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
      const { client_metadata: clientMetadata, ...compatibleBody } =
        replacementBody;
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
    const frames: Record<string, unknown>[] = [];
    const AgentSessionWebSocket = function AgentSessionWebSocket() {
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
        const response =
          frame.generate === false
            ? new Response(
                event({
                  response: { id: "resp_prewarm", status: "completed" },
                  type: "response.completed",
                })
              )
            : assistantResponse("agent-session-prewarm");
        void response.text().then((body) => {
          for (const line of body.split("\n\n")) {
            if (!line.startsWith("data: ")) {
              continue;
            }
            socket.dispatchEvent(
              new MessageEvent("message", { data: line.slice(6) })
            );
          }
        });
      };
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };
    vi.stubGlobal("WebSocket", AgentSessionWebSocket);
    const fetch = vi.fn<FetchFunction>(async () =>
      assistantResponse("unexpected-sse")
    );
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
    const networkRequests: Record<string, unknown>[] = [];
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
          (entry) => entry.type === "custom" || entry.type === "compaction"
        ).length,
        fetches: fetch.mock.calls.length,
        headerUntouched: after.headers,
        payloadUntouched: after.payloads,
        remoteFeature: networkHeaders[0]?.get("x-codex-beta-features"),
        requestMatchesPayload:
          JSON.stringify(networkRequests[0]) === after.payloads[0],
        roles: branch.flatMap((entry) =>
          entry.type === "message" ? [entry.message.role] : []
        ),
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
    const requests: Record<string, unknown>[] = [];
    const responses = [
      compactResponse("malformed-text"),
      assistantResponse("malformed-text"),
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
      extensionFactories: [addMalformedSentinel, codexCompactionExtension],
      model: {
        ...SPIKE_MODEL,
        contextWindow: 4000,
        maxTokens: 1000,
      },
      rootDir: paths.rootDir,
      sessionManager: manager,
      systemPrompt: "short",
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      await session.prompt("x".repeat(15_000));

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        preserved: requests.map((request) =>
          JSON.stringify(request).includes(`${FRAME_MARKER_PREFIX}bogus]`)
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
        notification:
          "OpenAI checkpoint replay was blocked because request markers are invalid.",
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
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-diagnostic")
        : assistantResponse(`diagnostic-source-${(ordinaryResponses += 1)}`);
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
      extensionFactories: [
        replaceContextWhen(() => replacementEnabled),
        codexCompactionExtension,
      ],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      await session.prompt("diagnostic source");
      await session.compact();
      replacementEnabled = true;
      await session.prompt("must fail closed");
      const observations = new CodexObservability(
        path.join(
          getExtensionStoragePaths("codex-provider").dataDir,
          "codex-provider.sqlite"
        )
      );
      const frameObservations = observations
        .list(manager.getSessionId())
        .filter((observation) => observation.kind === "context-frame-failure");
      observations.close();

      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        observationKinds: frameObservations.map(
          (observation) => observation.kind
        ),
      }).toStrictEqual({
        fetches: 3,
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
    const requests: Record<string, unknown>[] = [];
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
        injectCustomMessageWithPersistedTimestampDrift(
          () => injectCustomMessage
        ),
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
        opaqueCount: inputItemTypes(replayInput).filter(
          (type) => type === "compaction"
        ).length,
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
      if (JSON.stringify(request).includes("<conversation>")) {
        return assistantResponse("portable-retry-checkpoint");
      }
      ordinaryRequests += 1;
      if (ordinaryRequests === 2) {
        throw new TypeError("fetch failed");
      }
      return ordinaryRequests === 3
        ? toolCallResponse("retry-tool")
        : assistantResponse(
            ordinaryRequests === 1 ? "retry-seed" : "retry-final"
          );
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
            entry.message.stopReason === "error"
        ).length,
        fetches: fetch.mock.calls.length,
        finalStopReason: session.messages.findLast(
          (message) => message.role === "assistant"
        )?.stopReason,
      }).toStrictEqual({
        failedAssistants: 1,
        fetches: 6,
        finalStopReason: "stop",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("leaves a post-output provider failure to Pi's outer retry", async () => {
    const paths = await workspace("codex-outer-retry-partial-");
    const requests: Record<string, unknown>[] = [];
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
          branchEntry.type === "message" &&
          branchEntry.message.role === "assistant"
            ? [branchEntry.message]
            : []
        );
      const liveAssistants = session.messages.filter(
        (message) => message.role === "assistant"
      );

      expect({
        fetches: fetch.mock.calls.length,
        liveStops: liveAssistants.map((message) => message.stopReason),
        persistedStops: persistedAssistants.map(
          (message) => message.stopReason
        ),
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
    const frames: Record<string, unknown>[] = [];
    let generatedAttempts = 0;
    let socketAttempts = 0;
    const IncidentWebSocket = function IncidentWebSocket() {
      socketAttempts += 1;
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
              })
            )
          );
          setTimeout(() => socket.dispatchEvent(new Event("error")), 0);
          return;
        }
        for (const responseEvent of assistantEvents("ws-outer-retry-clean")) {
          queueMicrotask(() =>
            socket.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify(responseEvent),
              })
            )
          );
        }
      };
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
          branchEntry.type === "message" &&
          branchEntry.message.role === "assistant"
            ? [branchEntry.message]
            : []
        );
      const generatedFrames = frames.filter(
        (frame) => frame.generate !== false
      );

      expect({
        errors: persistedAssistants.map((message) => message.errorMessage),
        fetches: fetch.mock.calls.length,
        generatedAttempts,
        persistedStops: persistedAssistants.map(
          (message) => message.stopReason
        ),
        retryContext: JSON.stringify(generatedFrames[1]?.input),
        socketAttempts,
        winningText: assistantText(persistedAssistants[1]),
      }).toStrictEqual({
        errors: ["WebSocket error: stream failed", undefined],
        fetches: 0,
        generatedAttempts: 2,
        persistedStops: ["error", "stop"],
        retryContext: expect.not.stringContaining(
          "WebSocket error: stream failed"
        ),
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
    const fetch = vi.fn<FetchFunction>(async () =>
      compactResponse("append-failure")
    );
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      await session.prompt("x".repeat(15_000));
      concealCheckpoint = false;

      expect({
        active: resolveActiveCheckpointBoundary(manager.getBranch()).kind,
        customEntries: manager
          .getBranch()
          .filter((entry) => entry.type === "custom").length,
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      await session.prompt("x".repeat(15_000));

      expect({
        compactions: manager
          .getBranch()
          .filter((entry) => entry.type === "compaction").length,
        customEntries: manager
          .getBranch()
          .filter((entry) => entry.type === "custom").length,
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        compactions: 0,
        customEntries: 0,
        fetches: 1,
        notification:
          "OpenAI checkpoint generation failed; the model request was cancelled.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("persists both artifacts and uses the readable one after reload on an incompatible model", async () => {
    const paths = await workspace("codex-lifecycle-manual-");
    const requests: Record<string, unknown>[] = [];
    const requestHeaders: Headers[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requestHeaders.push(headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("manual");
      }
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-manual", 7)
        : assistantResponse(`manual-${requests.length}`);
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
    let incompatible:
      | Awaited<ReturnType<typeof createRealCodexSession>>
      | undefined;

    try {
      await session.prompt("manual lifecycle source");
      await session.compact();

      const installed = resolveActiveCheckpointBoundary(manager.getBranch());
      const installedEntry =
        installed.kind === "checkpoint"
          ? manager.getEntry(installed.boundaryEntryId)
          : undefined;
      const sessionFile = manager.getSessionFile();
      if (
        installed.kind !== "checkpoint" ||
        installedEntry?.type !== "compaction" ||
        !sessionFile
      ) {
        throw new Error("Manual checkpoint was not installed");
      }
      session.dispose();

      const resumedManager = SessionManager.continueRecent(
        paths.cwd,
        paths.sessionDir
      );
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
      const reloaded = resolveActiveCheckpointBoundary(
        resumedManager.getBranch()
      );
      resumedManager.branch(installed.boundaryEntryId);
      const branched = resolveActiveCheckpointBoundary(
        resumedManager.getBranch()
      );
      resumed.dispose();
      resumed = undefined;
      const incompatibleManager = SessionManager.continueRecent(
        paths.cwd,
        paths.sessionDir
      );
      incompatible = await createRealCodexSession({
        compaction: { enabled: false },
        extensionFactories: [codexCompactionExtension],
        model: NON_CODEX_MODEL,
        rootDir: paths.rootDir,
        sessionManager: incompatibleManager,
      });
      await incompatible.prompt("continue portably");
      const incompatibleInput = requests.at(-1)?.input;
      const incompatibleJson = JSON.stringify(incompatibleInput);
      const nativeRequestIndex = requests.findIndex((request) =>
        inputItemTypes(request.input).includes("compaction_trigger")
      );

      expect({
        branchCheckpoint:
          branched.kind === "checkpoint"
            ? branched.checkpoint.response.id
            : undefined,
        combinedUsage: installedEntry.usage,
        compactionFeature: requestHeaders[nativeRequestIndex]?.get(
          "x-codex-beta-features"
        ),
        fetches: fetch.mock.calls.length,
        incompatibleOpaque:
          inputItemTypes(incompatibleInput).includes("compaction"),
        incompatibleSummary: incompatibleJson.includes(
          "assistant-portable-manual"
        ),
        nativeUsage: installed.checkpoint.response.usage,
        reason: installed.checkpoint.reason,
        reloadCheckpoint:
          reloaded.kind === "checkpoint"
            ? reloaded.checkpoint.response.id
            : undefined,
        sameFile: resumedManager.getSessionFile() === sessionFile,
      }).toStrictEqual({
        branchCheckpoint: "resp_manual",
        combinedUsage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            total: 0,
          },
          input: 27,
          output: 5,
          reasoning: 0,
          totalTokens: 32,
        },
        compactionFeature: "remote_compaction_v2",
        fetches: 4,
        incompatibleOpaque: false,
        incompatibleSummary: true,
        nativeUsage: {
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

  it("isolates custom instructions to Pi's split summary and replays only opaque state", async () => {
    const paths = await workspace("codex-inline-manual-replay-");
    const requests: Record<string, unknown>[] = [];
    const requestHeaders: Headers[] = [];
    let ordinaryResponses = 0;
    let portableResponses = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requestHeaders.push(headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("manual-replay");
      }
      if (JSON.stringify(request).includes("<conversation>")) {
        portableResponses += 1;
        return assistantResponse(`portable-${portableResponses}`);
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
        inputItemTypes(request.input).includes("compaction_trigger")
      );
      const portableRequests = requests.filter((request) =>
        JSON.stringify(request).includes("<conversation>")
      );
      const replayInput = requests.at(-1)?.input;
      const serialized = JSON.stringify(replayInput);
      expect({
        beta: requestHeaders.at(-1)?.get("x-codex-beta-features"),
        compactedAssistantAbsent: !serialized.includes(
          "assistant-manual-replay-1"
        ),
        customInstructionCounts: {
          native:
            JSON.stringify(nativeRequest).split(customInstructions).length - 1,
          portable: portableRequests.map(
            (request) =>
              JSON.stringify(request).split(customInstructions).length - 1
          ),
          replay: serialized.split(customInstructions).length - 1,
        },
        fetches: fetch.mock.calls.length,
        opaqueCount: inputItemTypes(replayInput).filter(
          (type) => type === "compaction"
        ).length,
        portableSummaryAbsent:
          !serialized.includes("assistant-portable-1") &&
          !serialized.includes("assistant-portable-2"),
      }).toStrictEqual({
        beta: "remote_compaction_v2",
        compactedAssistantAbsent: true,
        customInstructionCounts: {
          native: 0,
          portable: [1, 0],
          replay: 0,
        },
        fetches: 6,
        opaqueCount: 1,
        portableSummaryAbsent: true,
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
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-replay-race")
        : assistantResponse("replay-race-source");
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [
        mutateBranchBeforeSecondProviderRequest,
        codexCompactionExtension,
      ],
      rootDir: paths.rootDir,
      sessionManager: manager,
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === "test-replay-race"
          ).length,
      }).toStrictEqual({
        fetches: 3,
        notification:
          "OpenAI checkpoint replay was blocked because session context changed after framing.",
        raceEntries: 1,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("falls back from corrupt inline state after a portable lifecycle boundary", async () => {
    const paths = await workspace("codex-inline-corrupt-after-native-");
    const notifications: string[] = [];
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("corrupt-source");
      }
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-corrupt-source")
        : assistantResponse("corrupt-source");
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      await session.prompt("create native boundary");
      await session.compact();
      manager.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { version: 9 });
      expect(resolveActiveCheckpointBoundary(manager.getBranch()).kind).toBe(
        "invalid-checkpoint"
      );
      await session.prompt("must not pass corrupt state");

      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        opaqueCount: inputItemTypes(requests.at(-1)?.input).filter(
          (type) => type === "compaction"
        ).length,
        portableSummary: JSON.stringify(requests.at(-1)?.input).includes(
          "assistant-portable-corrupt-source"
        ),
      }).toStrictEqual({
        fetches: 4,
        notification:
          "An incompatible OpenAI checkpoint was ignored because authoritative Pi context is available.",
        opaqueCount: 0,
        portableSummary: true,
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
    const requests: Record<string, unknown>[] = [];
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
          active.kind === "checkpoint"
            ? active.checkpoint.identity.model
            : undefined,
        checkpointResponse:
          active.kind === "checkpoint"
            ? active.checkpoint.response.id
            : undefined,
        models: requests.map((request) => request.model),
        reasons: metadata.map((value) =>
          value?.compaction && typeof value.compaction === "object"
            ? (value.compaction as Record<string, unknown>).reason
            : undefined
        ),
        triggers: requests.map((request) =>
          inputItemTypes(request.input).includes("compaction_trigger")
        ),
      }).toStrictEqual({
        checkpointModel: "gpt-5.6-current",
        checkpointResponse: "resp_current-fallback",
        models: [
          "gpt-5.6-previous",
          "gpt-5.6-previous",
          "gpt-5.6-current",
          "gpt-5.6-current",
        ],
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
    const requests: Record<string, unknown>[] = [];
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
      extensionFactories: [
        surroundContext,
        addEnvelopeFields,
        codexCompactionExtension,
      ],
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
        active.kind === "checkpoint"
          ? JSON.stringify(active.checkpoint.replacement)
          : "";

      expect({
        active: {
          carrier: active.kind === "checkpoint" ? active.carrier : undefined,
          phase:
            active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
          response:
            active.kind === "checkpoint"
              ? active.checkpoint.response.id
              : undefined,
        },
        checkpointMutationCount: [
          "earlier-context-prefix",
          "earlier-context-suffix",
        ].map((value) => checkpointJson.split(value).length - 1),
        envelopeParity: requests.map((request) => ({
          compactionReason: (
            turnMetadata(request)?.compaction as
              | Record<string, unknown>
              | undefined
          )?.reason,
          phase: (request.client_metadata as Record<string, unknown>)?.phase,
          requestKind: turnMetadata(request)?.request_kind,
          serviceTier: request.service_tier,
        })),
        featureHeaders: headersSeen.map((headers) =>
          headers.get("x-codex-beta-features")
        ),
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-provider:frame")
        ),
        normalOpaqueCount: inputItemTypes(normalInput).filter(
          (type) => type === "compaction"
        ).length,
        normalTrigger:
          inputItemTypes(normalInput).includes("compaction_trigger"),
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

  it("normalizes provider image detail before checkpoint persistence", async () => {
    const paths = await workspace("codex-inline-image-detail-");
    const imageModel: Model<"openai-codex-responses"> = {
      ...SPIKE_MODEL,
      contextWindow: 4000,
      input: ["text", "image"],
      maxTokens: 1000,
    };
    const requests: Record<string, unknown>[] = [];
    const responses = [
      compactResponse("image-detail"),
      assistantResponse("image-detail"),
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
      const requestJsons = requests.map((request) =>
        JSON.stringify(request.input)
      );

      expect({
        checkpointDetail: checkpointJson.includes('"detail"'),
        checkpointImage: checkpointJson.includes('"input_image"'),
        checkpointPlaceholder: checkpointJson.includes(
          "image content omitted from compacted history"
        ),
        fetches: fetch.mock.calls.length,
        requestDetails: requestJsons.map((request) =>
          request.includes('"detail"')
        ),
        requestImages: requestJsons.map((request) =>
          request.includes('"input_image"')
        ),
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
    const requests: Record<string, unknown>[] = [];
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
      const requestJsons = requests.map((request) =>
        JSON.stringify(request.input)
      );

      expect({
        checkpointDetail: checkpointJson.includes('"detail"'),
        checkpointImage: checkpointJson.includes('"input_image"'),
        checkpointPlaceholder: checkpointJson.includes(
          "image content omitted from compacted history"
        ),
        checkpointVersion: active.checkpoint.version,
        fetches: fetch.mock.calls.length,
        liteHeaders: headersSeen.map((headers) =>
          headers.get("x-openai-internal-codex-responses-lite")
        ),
        requestDetails: requestJsons.map((request) =>
          request.includes('"detail"')
        ),
        requestImages: requestJsons.map((request) =>
          request.includes('"input_image"')
        ),
        requestPrefixes: requests.map(
          (request) =>
            Array.isArray(request.input) &&
            request.input[0] &&
            typeof request.input[0] === "object" &&
            "type" in request.input[0] &&
            request.input[0].type
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
      expect(resolveActiveCheckpointBoundary(manager.getBranch()).kind).toBe(
        "none"
      );

      await session.prompt("trigger");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());

      expect({
        fetches: fetch.mock.calls.length,
        phase:
          active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
        response:
          active.kind === "checkpoint"
            ? active.checkpoint.response.id
            : undefined,
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
    const requests: Record<string, unknown>[] = [];
    const responses = [
      compactResponse("replaced-context"),
      assistantResponse("replaced-context"),
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
        replacementPresent: JSON.stringify(sideInput).includes(
          "replacement-context"
        ),
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
    const contextTokens: { value?: number } = {};
    const requests: Record<string, unknown>[] = [];
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
      extensionFactories: [
        addOneLargePayloadOnlyMessage(contextTokens),
        codexCompactionExtension,
      ],
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
          phase:
            active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
          response:
            active.kind === "checkpoint"
              ? active.checkpoint.response.id
              : undefined,
        },
        contextWasBelowThreshold:
          contextTokens.value !== undefined && contextTokens.value < 72_000,
        envelopePreserved: requests.map((request) => ({
          phase: (request.client_metadata as Record<string, unknown>)?.phase,
          requestKind: turnMetadata(request)?.request_kind,
        })),
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-provider:frame")
        ),
        payloadOnlyPreserved: [sideInput, pendingInput, replayInput].every(
          (input) => JSON.stringify(input).includes("payload-only:")
        ),
        pendingOpaque: inputItemTypes(pendingInput).filter(
          (type) => type === "compaction"
        ).length,
        replayOpaque: inputItemTypes(replayInput).filter(
          (type) => type === "compaction"
        ).length,
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
    const contextTokens: { value?: number } = {};
    const requests: Record<string, unknown>[] = [];
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
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === CHECKPOINT_CUSTOM_TYPE
              ).length
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
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "additional_tools"
      ) as Record<string, unknown> | undefined;
      const developerMessage = pendingInput.find(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "message" &&
          "role" in item &&
          item.role === "developer"
      );
      const toolNames = Array.isArray(additionalTools?.tools)
        ? additionalTools.tools.flatMap((tool) =>
            tool !== null &&
            typeof tool === "object" &&
            "name" in tool &&
            typeof tool.name === "string"
              ? [tool.name]
              : []
          )
        : [];
      const checkpointJson =
        active.kind === "checkpoint"
          ? JSON.stringify(active.checkpoint.replacement)
          : "";

      expect({
        checkpoint: active.kind,
        checkpointHasRequestState:
          checkpointJson.includes("post_compaction_probe") ||
          checkpointJson.includes("POST_COMPACTION_SYSTEM_SENTINEL"),
        developerInstruction: JSON.stringify(developerMessage).includes(
          "POST_COMPACTION_SYSTEM_SENTINEL"
        ),
        fetches: fetch.mock.calls.length,
        pendingOpaque: inputItemTypes(pendingInput).filter(
          (type) => type === "compaction"
        ).length,
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
      extensionFactories: [
        mutateBranchAndAddLargePayload,
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });

    try {
      await session.prompt("candidate race");
      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
        raceEntries: manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "test-candidate-race"
          ).length,
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
    const requests: Record<string, unknown>[] = [];
    const responses = [
      compactResponse("tool-split"),
      assistantResponse("tool-split-pending"),
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
          JSON.stringify(request).includes("codex-provider:frame")
        ),
        realResultPreserved: side.includes("REAL_SPLIT_RESULT"),
        syntheticResultAbsent: !side.includes("No result provided"),
        trigger: inputItemTypes(requests[0]?.input).includes(
          "compaction_trigger"
        ),
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
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-active-tool-split")
        : assistantResponse("active-tool-split-source");
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
      extensionFactories: [
        prependSplitToolCallWhen(() => splitEnabled),
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
        fetches: 3,
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
    const requests: Record<string, unknown>[] = [];
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
          (type) => type === "compaction"
        ).length,
        continuationToolOutput: JSON.stringify(continuationInput).includes(
          "function_call_output"
        ),
        fetches: fetch.mock.calls.length,
        phase:
          active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
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
    const requests: Record<string, unknown>[] = [];
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
    let portableResponses = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        nativeCompactions += 1;
        return compactResponse(nativeCompactions === 1 ? "first" : "second");
      }
      if (JSON.stringify(request).includes("<conversation>")) {
        portableResponses += 1;
        return assistantResponse(`portable-repeated-${portableResponses}`);
      }
      ordinaryResponses += 1;
      return assistantResponse(
        ordinaryResponses === 1 ? "first-source" : "second-source"
      );
    });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const compactEventEntryIds: string[] = [];
    const notifications: string[] = [];
    const observeCompactions: ExtensionFactory = (pi) => {
      pi.on("session_compact", (compactEvent) => {
        compactEventEntryIds.push(compactEvent.compactionEntry.id);
      });
    };
    const uiContext = {
      notify: (message: string) => notifications.push(message),
      setStatus: () => null,
    } as unknown as ExtensionUIContext;
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension, observeCompactions],
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
      expect({
        activeEntryMatchesEvent:
          newest.kind === "checkpoint" &&
          newest.boundaryEntryId === compactEventEntryIds[1],
        eventEntryIds: compactEventEntryIds,
        fetches: fetch.mock.calls.length,
        installErrors: notifications.filter((message) =>
          message.includes("installation could not be verified")
        ),
        newestResponse:
          newest.kind === "checkpoint"
            ? newest.checkpoint.response.id
            : undefined,
      }).toStrictEqual({
        activeEntryMatchesEvent: true,
        eventEntryIds: [
          first.boundaryEntryId,
          newest.kind === "checkpoint" ? newest.boundaryEntryId : undefined,
        ],
        fetches: 7,
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
      const serialized = JSON.stringify(request);
      if (
        inputItemTypes(request.input).includes("compaction_trigger") ||
        serialized.includes("<conversation>")
      ) {
        sideRequests += 1;
        if (sideRequests === 2) {
          sideRequestsStarted.resolve(null);
        }
        const pending = Promise.withResolvers<Response>();
        const response = inputItemTypes(request.input).includes(
          "compaction_trigger"
        )
          ? compactResponse("concurrent-native")
          : assistantResponse("concurrent-portable");
        pendingResponses.push({
          resolve: () => pending.resolve(response),
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
        compactions: manager
          .getBranch()
          .filter((entry) => entry.type === "compaction").length,
        notifications,
        reasons: results.map((result) =>
          result.status === "rejected" ? String(result.reason) : "fulfilled"
        ),
        sideRequests,
      }).toStrictEqual({
        compactions: 0,
        notifications: [],
        reasons: ["Error: Compaction cancelled", "Error: Compaction cancelled"],
        sideRequests: 2,
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
    let portableCompactions = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        nativeCompactions += 1;
        return compactResponse(`install-lock-${nativeCompactions}`);
      }
      if (JSON.stringify(request).includes("<conversation>")) {
        portableCompactions += 1;
        return assistantResponse(
          `install-lock-portable-${portableCompactions}`
        );
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
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
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
        compactions: manager
          .getBranch()
          .filter((entry) => entry.type === "compaction").length,
        installErrors: notifications.filter((message) =>
          message.includes("installation could not be verified")
        ),
        nativeCompactions,
        portableCompactions,
        statuses: results.map((result) => result.status),
      }).toStrictEqual({
        compactions: 0,
        installErrors: [],
        nativeCompactions: 1,
        portableCompactions: 1,
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
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-state-stale")
        : assistantResponse("state-source");
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
        compactions: manager
          .getBranch()
          .filter((branchEntry) => branchEntry.type === "compaction").length,
        fetches: fetch.mock.calls.length,
      }).toStrictEqual({
        after: before,
        before,
        compactions: 0,
        fetches: 3,
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
    const uiContext = {
      notify: (message: string) => notifications.push(message),
      setStatus: () => null,
    } as unknown as ExtensionUIContext;
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
          message.includes("authentication is unavailable")
        ),
        compactions: manager
          .getBranch()
          .filter((branchEntry) => branchEntry.type === "compaction").length,
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

  it.each([
    {
      choice: undefined,
      expectedSelects: 0,
      installed: true,
      label: "forced fallback",
      policy: "fallback",
      withUI: false,
    },
    {
      choice: undefined,
      expectedSelects: 0,
      installed: false,
      label: "forced cancel",
      policy: "cancel",
      withUI: false,
    },
    {
      choice: undefined,
      expectedSelects: 0,
      installed: false,
      label: "headless ask",
      policy: "ask",
      withUI: false,
    },
    {
      choice: "Use portable text summary",
      expectedSelects: 1,
      installed: true,
      label: "accepted ask",
      policy: "ask",
      withUI: true,
    },
    {
      choice: "Keep context unchanged",
      expectedSelects: 1,
      installed: false,
      label: "declined ask",
      policy: "ask",
      withUI: true,
    },
    {
      choice: undefined,
      expectedSelects: 1,
      installed: false,
      label: "dismissed ask",
      policy: "ask",
      withUI: true,
    },
    {
      choice: "Use portable text summary",
      expectedSelects: 1,
      installed: true,
      label: "invalid policy defaults to ask",
      policy: "not-a-policy",
      withUI: true,
    },
  ])("applies $label after native failure", async (testCase) => {
    vi.stubEnv("CLANKER_CODEX_COMPACTION_FAILURE", testCase.policy);
    const paths = await workspace("codex-lifecycle-policy-");
    const notifications: string[] = [];
    const select = vi.fn<() => Promise<string | undefined>>(
      async () => testCase.choice
    );
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return malformedCompactResponse();
      }
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-policy")
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
      uiContext: testCase.withUI
        ? ({
            notify: (message: string) => notifications.push(message),
            select,
            setStatus: () => null,
          } as unknown as ExtensionUIContext)
        : undefined,
    });

    try {
      await session.prompt("policy source");
      const before = manager.getBranch().map((branchEntry) => branchEntry.id);
      const installed = await session.compact().then(
        () => true,
        () => false
      );
      const compactions = manager
        .getBranch()
        .filter((branchEntry) => branchEntry.type === "compaction");
      const after = manager.getBranch().map((branchEntry) => branchEntry.id);

      expect({
        branchUnchanged:
          installed || JSON.stringify(after) === JSON.stringify(before),
        fetches: fetch.mock.calls.length,
        invalidWarnings: notifications.filter((message) =>
          message.includes("CLANKER_CODEX_COMPACTION_FAILURE")
        ).length,
        portableSummaryInstalled:
          compactions.length === 1 &&
          compactions[0]?.summary.includes("assistant-portable-policy"),
        selects: select.mock.calls.length,
      }).toStrictEqual({
        branchUnchanged: true,
        fetches: 3,
        invalidWarnings: testCase.policy === "not-a-policy" ? 1 : 0,
        portableSummaryInstalled: testCase.installed,
        selects: testCase.expectedSelects,
      });
      expect(installed).toBe(testCase.installed);
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    { native: "success", portable: "failure" },
    { native: "failure", portable: "failure" },
    { native: "abort", portable: "success" },
  ] as const)(
    "cancels without prompting when native=$native and portable=$portable",
    async ({ native, portable }) => {
      vi.stubEnv("CLANKER_CODEX_COMPACTION_FAILURE", "ask");
      const paths = await workspace("codex-lifecycle-result-matrix-");
      const select = vi.fn<() => Promise<string | undefined>>(
        async () => "Use portable text summary"
      );
      const fetch = vi.fn<FetchFunction>(async (_input, init) => {
        const headers = new Headers(init?.headers);
        const request = requestJson(init?.body, headers);
        if (inputItemTypes(request.input).includes("compaction_trigger")) {
          if (native === "abort") {
            const error = new Error("aborted native compaction");
            error.name = "AbortError";
            throw error;
          }
          return native === "success"
            ? compactResponse("result-matrix")
            : malformedCompactResponse();
        }
        if (JSON.stringify(request).includes("<conversation>")) {
          return portable === "success"
            ? assistantResponse("portable-result-matrix")
            : overflowResponse();
        }
        return assistantResponse("result-matrix-source");
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
        retry: { provider: { maxRetries: 0 } },
        rootDir: paths.rootDir,
        sessionManager: manager,
        uiContext: {
          notify: () => null,
          select,
          setStatus: () => null,
        } as unknown as ExtensionUIContext,
      });

      try {
        await session.prompt("result matrix source");
        const before = manager.getBranch().map((branchEntry) => branchEntry.id);
        await expect(session.compact()).rejects.toThrow("cancelled");
        const expectedFetches = native === "abort" ? 5 : 2;
        expect({
          after: manager.getBranch().map((branchEntry) => branchEntry.id),
          fetches: fetch.mock.calls.length,
          selects: select.mock.calls.length,
        }).toStrictEqual({
          after: before,
          fetches: expectedFetches,
          selects: 0,
        });
      } finally {
        session.dispose();
        await rm(paths.rootDir, { force: true, recursive: true });
      }
    }
  );

  it.each([
    { policy: "fallback", reason: "threshold" },
    { policy: "cancel", reason: "threshold" },
    { policy: "fallback", reason: "overflow" },
    { policy: "cancel", reason: "overflow" },
  ] as const)(
    "applies $policy after $reason remote failure",
    async ({ policy, reason }) => {
      vi.stubEnv("CLANKER_CODEX_COMPACTION_FAILURE", policy);
      const paths = await workspace("codex-lifecycle-automatic-policy-");
      let nativeCompactions = 0;
      let ordinaryRequests = 0;
      let portableRequests = 0;
      const fetch = vi.fn<FetchFunction>(async (_input, init) => {
        const headers = new Headers(init?.headers);
        const request = requestJson(init?.body, headers);
        if (inputItemTypes(request.input).includes("compaction_trigger")) {
          nativeCompactions += 1;
          return malformedCompactResponse();
        }
        if (JSON.stringify(request).includes("<conversation>")) {
          portableRequests += 1;
          return assistantResponse(`portable-${reason}-policy`);
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
          reserveTokens:
            reason === "threshold" ? SPIKE_MODEL.contextWindow - 5 : 1000,
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
        let expectedOrdinaryRequests = 1;
        if (reason === "overflow") {
          expectedOrdinaryRequests = policy === "fallback" ? 3 : 2;
        }
        expect({
          compactions: compactions.length,
          nativeCompactions,
          ordinaryRequests,
          portableRequests,
          portableSummaryInstalled:
            compactions.at(-1)?.type === "compaction" &&
            compactions.at(-1)?.summary.includes(`portable-${reason}-policy`),
        }).toStrictEqual({
          compactions: policy === "fallback" ? 1 : 0,
          nativeCompactions: 1,
          ordinaryRequests: expectedOrdinaryRequests,
          portableRequests: 1,
          portableSummaryInstalled: policy === "fallback",
        });
      } finally {
        session.dispose();
        await rm(paths.rootDir, { force: true, recursive: true });
      }
    }
  );

  it("leaves the branch unchanged when portable fallback persistence is missing", async () => {
    vi.stubEnv("CLANKER_CODEX_COMPACTION_FAILURE", "fallback");
    const paths = await workspace("codex-lifecycle-fallback-persistence-");
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return malformedCompactResponse();
      }
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-missing-persistence")
        : assistantResponse("persistence-source");
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
      await session.prompt("fallback persistence source");
      const before = manager.getBranch().map((branchEntry) => branchEntry.id);
      Object.defineProperty(manager, "appendCompaction", {
        value: () => "missing-compaction",
      });
      await session.compact();
      const after = manager.getBranch().map((branchEntry) => branchEntry.id);
      await session.prompt("continue after missing persistence");

      expect({
        branchAfterCompaction: after,
        originalContextPreserved: JSON.stringify(
          requests.at(-1)?.input
        ).includes("assistant-persistence-source"),
        portableSummaryAbsent: !JSON.stringify(requests.at(-1)?.input).includes(
          "portable-missing-persistence"
        ),
      }).toStrictEqual({
        branchAfterCompaction: before,
        originalContextPreserved: true,
        portableSummaryAbsent: true,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it.each(["abort", "branch", "model", "session", "reload"] as const)(
    "rejects an accepted delayed fallback after a %s change",
    async (change) => {
      vi.stubEnv("CLANKER_CODEX_COMPACTION_FAILURE", "ask");
      const paths = await workspace("codex-lifecycle-delayed-choice-");
      const choiceStarted = Promise.withResolvers<null>();
      const choice = Promise.withResolvers<string>();
      const fetch = vi.fn<FetchFunction>(async (_input, init) => {
        const headers = new Headers(init?.headers);
        const request = requestJson(init?.body, headers);
        if (inputItemTypes(request.input).includes("compaction_trigger")) {
          return malformedCompactResponse();
        }
        return JSON.stringify(request).includes("<conversation>")
          ? assistantResponse("portable-stale-choice")
          : assistantResponse("stale-choice-source");
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
        uiContext: {
          notify: () => null,
          select: async () => {
            choiceStarted.resolve(null);
            return choice.promise;
          },
          setStatus: () => null,
        } as unknown as ExtensionUIContext,
      });

      try {
        await session.prompt("delayed choice source");
        const compacting = session.compact();
        await choiceStarted.promise;
        if (change === "abort") {
          session.abortCompaction();
        } else if (change === "branch") {
          manager.appendCustomEntry("test-delayed-choice", { changed: true });
        } else if (change === "model") {
          await session.setModel({
            ...SPIKE_MODEL,
            id: "gpt-5.6-delayed-choice-other",
            name: "Delayed Choice Other",
          });
        } else if (change === "session") {
          manager.newSession();
        } else {
          await session.reload();
        }
        choice.resolve("Use portable text summary");

        await expect(compacting).rejects.toThrow("cancelled");
        expect({
          compactions: manager
            .getBranch()
            .filter((branchEntry) => branchEntry.type === "compaction").length,
          fetches: fetch.mock.calls.length,
        }).toStrictEqual({ compactions: 0, fetches: 3 });
      } finally {
        choice.resolve("Use portable text summary");
        session.dispose();
        await rm(paths.rootDir, { force: true, recursive: true });
      }
    }
  );

  it("uses the native lifecycle result for Pi threshold compaction", async () => {
    const paths = await workspace("codex-lifecycle-threshold-");
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("threshold");
      }
      return JSON.stringify(request).includes("<conversation>")
        ? assistantResponse("portable-threshold")
        : assistantResponse("threshold");
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
        active.kind === "checkpoint"
          ? manager.getEntry(active.boundaryEntryId)
          : undefined;
      expect({
        carrier: active.kind === "checkpoint" ? active.carrier : undefined,
        fetches: fetch.mock.calls.length,
        fromHook:
          activeEntry?.type === "compaction" ? activeEntry.fromHook : undefined,
        portableSummary:
          activeEntry?.type === "compaction" &&
          activeEntry.summary.includes("assistant-portable-threshold"),
        reason:
          active.kind === "checkpoint" ? active.checkpoint.reason : undefined,
      }).toStrictEqual({
        carrier: "lifecycle",
        fetches: 3,
        fromHook: true,
        portableSummary: true,
        reason: "threshold",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("lets Pi perform exactly one overflow retry after lifecycle success", async () => {
    const paths = await workspace("codex-lifecycle-overflow-");
    const requests: Record<string, unknown>[] = [];
    let ordinaryRequests = 0;
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const request = requestJson(init?.body, headers);
      requests.push(request);
      if (inputItemTypes(request.input).includes("compaction_trigger")) {
        return compactResponse("overflow");
      }
      if (JSON.stringify(request).includes("<conversation>")) {
        return assistantResponse("portable-overflow");
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
        compactions: manager
          .getBranch()
          .filter((entry) => entry.type === "compaction").length,
        fetches: fetch.mock.calls.length,
        opaqueCount: inputItemTypes(retryInput).filter(
          (type) => type === "compaction"
        ).length,
        phase:
          active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
        reason:
          active.kind === "checkpoint" ? active.checkpoint.reason : undefined,
        retryHasTrigger:
          inputItemTypes(retryInput).includes("compaction_trigger"),
      }).toStrictEqual({
        assistantStopReasons: ["stop"],
        compactions: 1,
        fetches: 5,
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
