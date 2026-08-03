import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  RETAINED_USER_IMAGE_PLACEHOLDER,
  parseCheckpoint,
} from "../checkpoint.js";
import {
  buildContextFrameDiagnostic,
  buildLifecycleCheckpoint,
  buildLifecycleSource,
  codexCompactionExtension,
  combineCompactionUsage,
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
import { SPIKE_MODEL } from "./fixtures.js";

const userInput = (text: string) => ({
  content: [{ text, type: "input_text" as const }],
  role: "user" as const,
  type: "message" as const,
});

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

  it("blocks nonportable lifecycle state but permits authoritative inline history in replay-only mode", async () => {
    const execution = {
      compaction: {
        encrypted_content: "opaque-replay-only",
        id: "cmp_replay_only",
        type: "compaction",
      },
      estimatedSourceTokens: 100,
      ok: true,
      responseId: "resp_replay_only",
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 10,
        output: 3,
        totalTokens: 13,
      },
    } satisfies LifecycleExecutionSuccess;
    const v4 = buildLifecycleCheckpoint({
      execution,
      model: SPIKE_MODEL,
      phase: "standalone",
      reason: "manual",
    });
    const v5 = buildLifecycleCheckpoint({
      execution,
      model: SPIKE_MODEL,
      phase: "pre-sampling",
      reason: "threshold",
      runtime: {
        compHash: "hash-replay-only",
        currentWindowId: "window-replay-only",
        effectiveTokenLimit: 100_000,
        previousWindowId: null,
        requestSchemaVersion: 1,
        windowNumber: 1,
      },
    });
    type Hook = (
      event: { readonly branchEntries: readonly SessionEntry[] },
      ctx: { readonly model: typeof SPIKE_MODEL }
    ) => Promise<unknown>;
    let hook: Hook | undefined;
    const previousReplacement = process.env.CLANKER_CODEX_PROVIDER_REPLACEMENT;
    process.env.CLANKER_CODEX_PROVIDER_REPLACEMENT = "0";
    try {
      await codexCompactionExtension({
        on(name: string, registered: unknown) {
          if (name === "session_before_compact") {
            hook = registered as Hook;
          }
        },
        registerEntryRenderer() {},
      } as never);
    } finally {
      if (previousReplacement === undefined) {
        delete process.env.CLANKER_CODEX_PROVIDER_REPLACEMENT;
      } else {
        process.env.CLANKER_CODEX_PROVIDER_REPLACEMENT = previousReplacement;
      }
    }
    const run = hook;
    if (!run) {
      throw new Error("session_before_compact hook was not registered");
    }

    expect([
      await run({ branchEntries: [] }, { model: SPIKE_MODEL }),
      await run(
        {
          branchEntries: [
            entry("v4", {
              details: { checkpoint: v4, type: CHECKPOINT_CUSTOM_TYPE },
              firstKeptEntryId: "v4",
              summary: "opaque",
              tokensBefore: 100,
              type: "compaction",
            }),
          ],
        },
        { model: SPIKE_MODEL }
      ),
      await run(
        {
          branchEntries: [
            entry("v5", {
              customType: CHECKPOINT_CUSTOM_TYPE,
              data: v5,
              type: "custom",
            }),
          ],
        },
        { model: SPIKE_MODEL }
      ),
    ]).toStrictEqual([undefined, { cancel: true }, undefined]);
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

  it("restores V5 transition provenance and preserves a missing hash", () => {
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
