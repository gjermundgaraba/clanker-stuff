import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
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
  combineCompactionUsage,
  createCodexLifecycle,
  decideModelTransitionReason,
  freshAssistantUsageTokens,
  hasResolvedLifecycleAuth,
  isInlineInstallationResolvable,
  isLifecycleInstallationResolvable,
  isSupportedLifecycleModel,
  mergeRemoteCompactionFeatureHeader,
  parseCompactionFailurePolicy,
  parseFinalizedResponsesEnvelope,
  resolvePreviousTurnTransition,
  shouldCompactFinalizedInput,
} from "../lifecycle.js";
import type { LifecycleExecutionSuccess } from "../lifecycle.js";
import { CodexObservability } from "../observability.js";
import { responseEvents, SPIKE_API_KEY, SPIKE_MODEL, sse } from "./fixtures.js";

const userInput = (text: string) => ({
  content: [{ text, type: "input_text" as const }],
  role: "user" as const,
  type: "message" as const,
});

const CHECKPOINT_RUNTIME = {
  compHash: null,
  currentWindowId: "window-test",
  effectiveTokenLimit: 100_000,
  previousWindowId: null,
  requestSchemaVersion: 1 as const,
  windowNumber: 1,
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

// oxlint-disable-next-line eslint/prefer-arrow-callback -- WebSocket constructors must be constructable
const FailingWebSocket = function FailingWebSocket() {
  throw new Error("unavailable");
};

describe("transport fallback notification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warns once after the next successful assistant message", async () => {
    vi.stubGlobal("WebSocket", FailingWebSocket);
    const notifications: [string, string][] = [];
    const sessionId = "fallback-session";
    const ctx = {
      sessionManager: { getSessionId: () => sessionId },
      ui: {
        notify: (message: string, type: string) => {
          notifications.push([message, type]);
        },
      },
    } as unknown as ExtensionContext;
    const observability = new CodexObservability(":memory:");
    const lifecycle = createCodexLifecycle({} as never, observability);
    const output = await lifecycle.provider
      .streamSimple(
        SPIKE_MODEL,
        { messages: [], systemPrompt: "System truth" },
        {
          apiKey: SPIKE_API_KEY,
          fetch: async () => sse(responseEvents("resp_fallback", "ok")),
          sessionId,
        }
      )
      .result();

    lifecycle.messageEnd(
      {
        message: { ...output, stopReason: "error" },
        type: "message_end",
      },
      ctx
    );
    lifecycle.messageEnd(
      {
        message: {
          ...output,
          api: "anthropic-messages",
          model: "claude-test",
          provider: "anthropic",
        },
        type: "message_end",
      },
      ctx
    );
    expect(notifications).toStrictEqual([]);
    lifecycle.messageEnd({ message: output, type: "message_end" }, ctx);
    lifecycle.messageEnd({ message: output, type: "message_end" }, ctx);

    expect(notifications).toStrictEqual([
      [
        "OpenAI Codex WebSocket is unavailable; using SSE for this session.",
        "warning",
      ],
    ]);
    observability.close();
  });
});

describe("observability lifecycle", () => {
  it("keeps observations in memory when Pi has no session file", () => {
    const observability = new CodexObservability("persistent.sqlite");
    const lifecycle = createCodexLifecycle(
      { getFlag: () => false } as never,
      observability
    );
    lifecycle.start({
      sessionManager: {
        getSessionFile: vi.fn<() => string | undefined>(),
        getSessionId: () => "ephemeral-session",
      },
      ui: { notify: vi.fn<() => void>(), setStatus: vi.fn<() => void>() },
    } as unknown as ExtensionContext);

    expect(observability.path).toBe(":memory:");
    observability.close();
  });
});

describe("lifecycle source and checkpoint construction", () => {
  it("parses failure policy and merges complete usage", () => {
    const first = {
      cacheRead: 2,
      cacheWrite: 3,
      cacheWrite1h: 1,
      cost: {
        cacheRead: 0.2,
        cacheWrite: 0.3,
        input: 0.1,
        output: 0.4,
        total: 1,
      },
      input: 10,
      output: 4,
      reasoning: 2,
      totalTokens: 19,
    };
    const second = {
      cacheRead: 5,
      cacheWrite: 7,
      cost: {
        cacheRead: 2,
        cacheWrite: 3,
        input: 1,
        output: 4,
        total: 10,
      },
      input: 20,
      output: 8,
      totalTokens: 40,
    };

    expect({
      policies: [undefined, " ask ", "FALLBACK", "cancel", "invalid"].map(
        parseCompactionFailurePolicy
      ),
      usage: combineCompactionUsage(first, second),
    }).toStrictEqual({
      policies: [
        { invalid: false, policy: "ask" },
        { invalid: false, policy: "ask" },
        { invalid: false, policy: "fallback" },
        { invalid: false, policy: "cancel" },
        { invalid: true, policy: "ask" },
      ],
      usage: {
        cacheRead: 7,
        cacheWrite: 10,
        cacheWrite1h: 1,
        cost: {
          cacheRead: 2.2,
          cacheWrite: 3.3,
          input: 1.1,
          output: 4.4,
          total: 11,
        },
        input: 30,
        output: 12,
        reasoning: 2,
        totalTokens: 59,
      },
    });
  });

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
      retainedItems: source.retainedItems,
    }).toStrictEqual({
      contextText: "old user|assistant|new user",
      prefix: [],
      retainedItems: [userInput("old user"), userInput("new user")],
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
        retainedItems: noPriorCompaction.retainedItems,
      },
    }).toStrictEqual({
      afterOrdinary: {
        ignored: true,
        prefix: [],
      },
      noPriorCompaction: {
        ignored: true,
        prefix: [],
        retainedItems: [
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
      retainedItems: [
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
      runtime: CHECKPOINT_RUNTIME,
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
        retainedItems: repeatedSource.retainedItems,
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
        retainedItems: [
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

  it("restores transition provenance and preserves a missing hash", () => {
    const previousModel = { ...SPIKE_MODEL, id: "model-a", name: "Model A" };
    const currentModel = { ...SPIKE_MODEL, id: "model-b", name: "Model B" };
    const checkpoint = buildLifecycleCheckpoint({
      execution: {
        compaction: {
          encrypted_content: "opaque-transition",
          id: "cmp_transition",
          type: "compaction",
        },
        estimatedSourceTokens: 100,
        ok: true,
        responseId: "resp_transition",
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 10,
          output: 3,
          totalTokens: 13,
        },
      },
      model: previousModel,
      phase: "pre-sampling",
      reason: "threshold",
      retainedItems: [],
      runtime: {
        compHash: "hash-a",
        currentWindowId: "window-a",
        effectiveTokenLimit: 100_000,
        previousWindowId: null,
        requestSchemaVersion: 1,
        windowNumber: 1,
      },
    });
    const branch = [
      entry("checkpoint", {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: checkpoint,
        type: "custom",
      }),
    ];
    const transition = resolvePreviousTurnTransition(
      branch,
      currentModel,
      (_provider, model) =>
        model === previousModel.id ? previousModel : undefined
    );

    expect({
      differentModelDownshift: decideModelTransitionReason({
        currentEffectiveTokenLimit: 50,
        currentModel: currentModel.id,
        estimatedTokens: 51,
        previousEffectiveTokenLimit: 100,
        previousModel: previousModel.id,
      }),
      missingHashReason: decideModelTransitionReason({
        currentCompHash: "hash-b",
        currentModel: currentModel.id,
        estimatedTokens: 1,
        previousCompHash: null,
        previousEffectiveTokenLimit: 100_000,
        previousModel: previousModel.id,
      }),
      previousHash: transition?.previousCompHash,
      previousModel: transition?.previousModel.id,
      sameModelDownshift: decideModelTransitionReason({
        currentEffectiveTokenLimit: 50,
        currentModel: currentModel.id,
        estimatedTokens: 51,
        previousEffectiveTokenLimit: 100,
        previousModel: currentModel.id,
      }),
      transitionReason: decideModelTransitionReason({
        currentCompHash: "hash-b",
        currentModel: currentModel.id,
        estimatedTokens: 1,
        previousCompHash: transition?.previousCompHash,
        previousEffectiveTokenLimit:
          transition?.previousEffectiveTokenLimit ?? 0,
        previousModel: transition?.previousModel.id ?? "",
      }),
    }).toStrictEqual({
      differentModelDownshift: "model_downshift",
      missingHashReason: undefined,
      previousHash: "hash-a",
      previousModel: "model-a",
      sameModelDownshift: undefined,
      transitionReason: "comp_hash_changed",
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
      retainedItems: [userInput("retained")],
      runtime: CHECKPOINT_RUNTIME,
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
