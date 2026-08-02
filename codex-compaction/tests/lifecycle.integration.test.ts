import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type { FetchFunction, Model } from "@earendil-works/pi-ai";
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
import {
  CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE,
  ENCRYPTED_CHECKPOINT_MARKER,
  codexCompactionExtension,
  lifecycleExtension,
} from "../lifecycle.js";
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

const inputItemTypes = (input: unknown) =>
  Array.isArray(input)
    ? input.flatMap((item) =>
        item && typeof item === "object" && "type" in item ? [item.type] : []
      )
    : [];

const assistantResponse = (id = "normal", inputTokens = 10) => {
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
  return new Response(
    [
      event({
        response: { id: `resp_${id}`, status: "in_progress" },
        type: "response.created",
      }),
      event({
        item: {
          content: [],
          id: message.id,
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.added",
      }),
      event({
        content_index: 0,
        delta: `assistant-${id}`,
        output_index: 0,
        type: "response.output_text.delta",
      }),
      event({
        item: message,
        output_index: 0,
        type: "response.output_item.done",
      }),
      event({
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
      }),
    ].join(""),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }
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

const toolCallResponse = (id = "tool") => {
  const item = {
    arguments: "{}",
    call_id: `call_${id}`,
    id: `fc_${id}`,
    name: "large_result",
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
    return {
      ...payload,
      input: [
        {
          role: "developer",
          tools: [],
          type: "additional_tools",
        },
        ...input,
      ],
    };
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
                text: `payload-only:${"p".repeat(16_000)}`,
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
    vi.unstubAllGlobals();
  });

  it("leaves an unchanged request body byte-identical and merges its feature header", async () => {
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

      expect({
        bodyBytesEqual: Buffer.compare(bodies[0] ?? [], bodies[1] ?? []) === 0,
        combinedFeatures: headersSeen[1]?.get("x-codex-beta-features"),
        fetches: fetch.mock.calls.length,
      }).toStrictEqual({
        bodyBytesEqual: true,
        combinedFeatures: "existing_one,REMOTE_COMPACTION_V2",
        fetches: 2,
      });
    } finally {
      baseline.dispose();
      combined.dispose();
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

  it("persists a redacted diagnostic when active replay cannot frame context", async () => {
    const paths = await workspace("codex-active-frame-diagnostic-");
    const notifications: string[] = [];
    const responses = [
      assistantResponse("diagnostic-source"),
      compactResponse("diagnostic"),
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
      const diagnosticEntries = manager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE
        );

      expect({
        diagnosticKinds: diagnosticEntries.map((entry) =>
          entry.type === "custom" &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          "kind" in entry.data
            ? entry.data.kind
            : undefined
        ),
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        diagnosticKinds: ["context-frame"],
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because request context could not be framed safely. A redacted diagnostic was saved with the session.",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("replays after Pi omits an auto-retry error from live context", async () => {
    const paths = await workspace("codex-auto-retry-alignment-");
    const fetch = vi
      .fn<FetchFunction>()
      .mockImplementationOnce(async () => assistantResponse("retry-seed"))
      .mockImplementationOnce(async () => compactResponse("retry-checkpoint"))
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async () => toolCallResponse("retry-tool"))
      .mockImplementationOnce(async () => assistantResponse("retry-final"));
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
        diagnostics: branch.filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE
        ).length,
        failedAssistants: branch.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "error"
        ).length,
        fetches: fetch.mock.calls.length,
        finalStopReason: session.messages
          .toReversed()
          .find((message) => message.role === "assistant")?.stopReason,
      }).toStrictEqual({
        diagnostics: 0,
        failedAssistants: 1,
        fetches: 5,
        finalStopReason: "stop",
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

  it("persists manual checkpoint details and keeps them resolvable after reload and branch", async () => {
    const paths = await workspace("codex-lifecycle-manual-");
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(async () => assistantResponse("manual"))
      .mockImplementationOnce(async () => compactResponse("manual"));
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.create(paths.cwd, paths.sessionDir);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [lifecycleExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });
    let resumed: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;

    try {
      await session.prompt("manual lifecycle source");
      await session.compact();

      const installed = resolveActiveCheckpointBoundary(manager.getBranch());
      const sessionFile = manager.getSessionFile();
      if (installed.kind !== "checkpoint" || !sessionFile) {
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
        extensionFactories: [lifecycleExtension],
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

      expect({
        branchCheckpoint:
          branched.kind === "checkpoint"
            ? branched.checkpoint.response.id
            : undefined,
        fetches: fetch.mock.calls.length,
        markerReloaded: JSON.stringify(resumed.messages).includes(
          ENCRYPTED_CHECKPOINT_MARKER
        ),
        reason: installed.checkpoint.reason,
        reloadCheckpoint:
          reloaded.kind === "checkpoint"
            ? reloaded.checkpoint.response.id
            : undefined,
        sameFile: resumedManager.getSessionFile() === sessionFile,
      }).toStrictEqual({
        branchCheckpoint: "resp_manual",
        fetches: 2,
        markerReloaded: true,
        reason: "manual",
        reloadCheckpoint: "resp_manual",
        sameFile: true,
      });
    } finally {
      session.dispose();
      resumed?.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("replays a manual lifecycle checkpoint on the next normal request", async () => {
    const paths = await workspace("codex-inline-manual-replay-");
    const requests: Record<string, unknown>[] = [];
    const requestHeaders: Headers[] = [];
    const responses = [
      assistantResponse("manual-replay-source"),
      compactResponse("manual-replay"),
      assistantResponse("manual-replay-after"),
    ];
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requestHeaders.push(headers);
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
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("manual replay source");
      await session.compact();
      await session.prompt("normal request after lifecycle");

      const replayInput = requests[2]?.input;
      const serialized = JSON.stringify(replayInput);
      expect({
        beta: requestHeaders[2]?.get("x-codex-beta-features"),
        compactedAssistantAbsent: !serialized.includes(
          "assistant-manual-replay-source"
        ),
        fetches: fetch.mock.calls.length,
        markerAbsent: !serialized.includes(ENCRYPTED_CHECKPOINT_MARKER),
        opaqueCount: inputItemTypes(replayInput).filter(
          (type) => type === "compaction"
        ).length,
      }).toStrictEqual({
        beta: "remote_compaction_v2",
        compactedAssistantAbsent: true,
        fetches: 3,
        markerAbsent: true,
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
    const responses = [
      assistantResponse("replay-race-source"),
      compactResponse("replay-race"),
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

  it("blocks normal replay when checkpoint identity is incompatible", async () => {
    const paths = await workspace("codex-inline-incompatible-");
    const notifications: string[] = [];
    const responses = [
      assistantResponse("incompatible-source"),
      compactResponse("incompatible"),
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
    const original = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });
    let incompatible:
      | Awaited<ReturnType<typeof createRealCodexSession>>
      | undefined;

    try {
      await original.prompt("create incompatible checkpoint");
      await original.compact();
      original.dispose();
      incompatible = await createRealCodexSession({
        compaction: {
          enabled: false,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
        extensionFactories: [codexCompactionExtension],
        model: {
          ...SPIKE_MODEL,
          id: "gpt-incompatible",
          name: "Incompatible Codex",
        },
        rootDir: paths.rootDir,
        sessionManager: manager,
        uiContext: {
          notify: (message: string) => notifications.push(message),
          setStatus: () => null,
        } as unknown as ExtensionUIContext,
      });
      await incompatible.prompt("must not reach provider");

      expect({
        fetches: fetch.mock.calls.length,
        notification: notifications.at(-1),
      }).toStrictEqual({
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because active native context is unsafe.",
      });
    } finally {
      original.dispose();
      incompatible?.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("blocks corrupt inline state after a native lifecycle boundary", async () => {
    const paths = await workspace("codex-inline-corrupt-after-native-");
    const notifications: string[] = [];
    const responses = [
      assistantResponse("corrupt-source"),
      compactResponse("corrupt-source"),
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
      }).toStrictEqual({
        fetches: 2,
        notification:
          "OpenAI checkpoint replay was blocked because active native context is unsafe.",
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
        envelopeParity: requests.map((request) => ({
          clientMetadata: request.client_metadata,
          serviceTier: request.service_tier,
        })),
        featureHeaders: headersSeen.map((headers) =>
          headers.get("x-codex-beta-features")
        ),
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-compaction:frame")
        ),
        mutationsPreserved: requests.map(
          (request) =>
            JSON.stringify(request).includes("earlier-context-prefix") &&
            JSON.stringify(request).includes("earlier-context-suffix")
        ),
        normalOpaqueCount: inputItemTypes(normalInput).filter(
          (type) => type === "compaction"
        ).length,
        normalTrigger:
          inputItemTypes(normalInput).includes("compaction_trigger"),
        sideTrigger: inputItemTypes(sideInput).at(-1) === "compaction_trigger",
      }).toStrictEqual({
        active: {
          carrier: "inline",
          phase: "pre-sampling",
          response: "resp_inline-pre-sampling",
        },
        envelopeParity: [
          {
            clientMetadata: { phase: "three" },
            serviceTier: "priority",
          },
          {
            clientMetadata: { phase: "three" },
            serviceTier: "priority",
          },
        ],
        featureHeaders: ["remote_compaction_v2", "remote_compaction_v2"],
        fetches: 2,
        markerLeak: false,
        mutationsPreserved: [true, true],
        normalOpaqueCount: 1,
        normalTrigger: false,
        sideTrigger: true,
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
        checkpointVersion: 4,
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
      contextWindow: 4000,
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
          contextTokens.value !== undefined && contextTokens.value < 3600,
        envelopePreserved: requests.map((request) => request.client_metadata),
        fetches: fetch.mock.calls.length,
        markerLeak: requests.some((request) =>
          JSON.stringify(request).includes("codex-compaction:frame")
        ),
        payloadOnlyInAuthoritativeSideInput:
          JSON.stringify(sideInput).includes("payload-only:") &&
          !JSON.stringify(pendingInput).includes("payload-only:") &&
          !JSON.stringify(replayInput).includes("payload-only:"),
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
          { phase: "four" },
          { phase: "four" },
          { phase: "four" },
        ],
        fetches: 3,
        markerLeak: false,
        payloadOnlyInAuthoritativeSideInput: true,
        pendingOpaque: 1,
        replayOpaque: 1,
        sideTrigger: true,
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
          JSON.stringify(request).includes("codex-compaction:frame")
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
    const responses = [
      assistantResponse("active-tool-split-source"),
      compactResponse("active-tool-split"),
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

  it("accepts the newest repeated-marker lifecycle install despite Pi's stale event entry", async () => {
    const paths = await workspace("codex-lifecycle-repeated-");
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(async () => assistantResponse("first-source"))
      .mockImplementationOnce(async () => compactResponse("first"))
      .mockImplementationOnce(async () => assistantResponse("second-source"))
      .mockImplementationOnce(async () => compactResponse("second"));
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
      extensionFactories: [lifecycleExtension, observeCompactions],
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
        activeEntryDiffersFromStaleEvent:
          newest.kind === "checkpoint" &&
          newest.boundaryEntryId !== compactEventEntryIds[1],
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
        activeEntryDiffersFromStaleEvent: true,
        eventEntryIds: [first.boundaryEntryId, first.boundaryEntryId],
        fetches: 4,
        installErrors: [],
        newestResponse: "resp_second",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("discards delayed compaction when active request state changes", async () => {
    const paths = await workspace("codex-lifecycle-request-state-");
    const delayed = Promise.withResolvers<Response>();
    const sideRequestStarted = Promise.withResolvers<null>();
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(async () => assistantResponse("state-source"))
      .mockImplementationOnce(async () => {
        sideRequestStarted.resolve(null);
        return delayed.promise;
      });
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [lifecycleExtension],
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
      extensionFactories: [lifecycleExtension],
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

  it("uses the native lifecycle result for Pi threshold compaction", async () => {
    const paths = await workspace("codex-lifecycle-threshold-");
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(async () => assistantResponse("threshold"))
      .mockImplementationOnce(async () => compactResponse("threshold"));
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: SPIKE_MODEL.contextWindow - 5,
      },
      extensionFactories: [lifecycleExtension],
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
        marker:
          activeEntry?.type === "compaction" ? activeEntry.summary : undefined,
        reason:
          active.kind === "checkpoint" ? active.checkpoint.reason : undefined,
      }).toStrictEqual({
        carrier: "lifecycle",
        fetches: 2,
        fromHook: true,
        marker: ENCRYPTED_CHECKPOINT_MARKER,
        reason: "threshold",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("lets Pi perform exactly one overflow retry after lifecycle success", async () => {
    const paths = await workspace("codex-lifecycle-overflow-");
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(async () => assistantResponse("seed"))
      .mockImplementationOnce(async () => overflowResponse())
      .mockImplementationOnce(async () => compactResponse("overflow"))
      .mockImplementationOnce(async () => assistantResponse("retry"));
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [lifecycleExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("seed overflow history");
      await session.prompt("overflow lifecycle source");
      const active = resolveActiveCheckpointBoundary(manager.getBranch());
      expect({
        assistantStopReasons: session.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.stopReason),
        fetches: fetch.mock.calls.length,
        phase:
          active.kind === "checkpoint" ? active.checkpoint.phase : undefined,
        reason:
          active.kind === "checkpoint" ? active.checkpoint.reason : undefined,
      }).toStrictEqual({
        assistantStopReasons: ["stop"],
        fetches: 4,
        phase: "overflow-retry",
        reason: "overflow",
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("replays opaque state instead of the marker on overflow retry", async () => {
    const paths = await workspace("codex-inline-overflow-replay-");
    const requests: Record<string, unknown>[] = [];
    const responses = [
      assistantResponse("overflow-replay-seed"),
      overflowResponse(),
      compactResponse("overflow-replay"),
      assistantResponse("overflow-replay-final"),
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
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [codexCompactionExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("overflow replay seed");
      await session.prompt("overflow replay source");
      const retryInput = requests[3]?.input;
      const serialized = JSON.stringify(retryInput) ?? "";

      expect({
        compactions: manager
          .getBranch()
          .filter((entry) => entry.type === "compaction").length,
        fetches: fetch.mock.calls.length,
        markerAbsent: !serialized.includes(ENCRYPTED_CHECKPOINT_MARKER),
        opaqueCount: inputItemTypes(retryInput).filter(
          (type) => type === "compaction"
        ).length,
        retryHasTrigger:
          inputItemTypes(retryInput).includes("compaction_trigger"),
      }).toStrictEqual({
        compactions: 1,
        fetches: 4,
        markerAbsent: true,
        opaqueCount: 1,
        retryHasTrigger: false,
      });
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it("cancels remote failure without textual fallback or branch loss", async () => {
    const paths = await workspace("codex-lifecycle-failure-");
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(async () => assistantResponse("before-failure"))
      .mockImplementationOnce(async () => malformedCompactResponse());
    vi.stubGlobal("fetch", fetch);
    const manager = SessionManager.inMemory(paths.cwd);
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [lifecycleExtension],
      rootDir: paths.rootDir,
      sessionManager: manager,
    });

    try {
      await session.prompt("preserve this branch");
      const before = manager.getBranch().map((entry) => entry.id);
      await expect(session.compact()).rejects.toThrow("cancelled");
      expect({
        after: manager.getBranch().map((entry) => entry.id),
        before,
        compactions: manager
          .getBranch()
          .filter((entry) => entry.type === "compaction").length,
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
});
