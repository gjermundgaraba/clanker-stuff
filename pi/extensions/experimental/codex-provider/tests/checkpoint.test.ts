import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  canUseInlineLocalFallback,
  canonicalJson,
  decideCheckpointCompatibility,
  isPortableLifecycleCompaction,
  parseCheckpoint,
  resolveActiveCheckpointBoundary,
  sha256Canonical,
} from "../checkpoint.js";

const compaction = (encryptedContent = "enc_new") => ({
  encrypted_content: encryptedContent,
  id: "cmp_new",
  internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
  type: "compaction",
});

const user = (text = "hello") => ({
  content: [{ text, type: "input_text" }],
  role: "user",
  type: "message",
});

interface CheckpointFixture {
  [key: string]: unknown;
  identity: {
    [key: string]: unknown;
    api: string;
    baseUrl: string | null;
    model: string;
    provider: string;
  };
  phase: string;
  protocol: string;
  reason: string;
  replacement: unknown[];
  replacementSha256: string;
  response: {
    id: string;
    usage: {
      cacheRead: number;
      cacheWrite: number;
      input: number;
      output: number;
      totalTokens: number;
    };
  };
  runtime: {
    compHash: string | null;
    currentWindowId: string;
    effectiveTokenLimit: number;
    previousWindowId: string | null;
    requestSchemaVersion: number;
    windowNumber: number;
  };
  schema: string;
  sourceTokens: number;
  version: number;
}

const validCheckpoint = (): CheckpointFixture => {
  const replacement = [user(), compaction()];
  return {
    identity: {
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.2-codex",
      provider: "openai-codex",
    },
    phase: "pre-sampling",
    protocol: "openai-responses-compaction-v2",
    reason: "threshold",
    replacement,
    replacementSha256: sha256Canonical(replacement),
    response: {
      id: "resp_1",
      usage: {
        cacheRead: 4,
        cacheWrite: 0,
        input: 100,
        output: 20,
        totalTokens: 120,
      },
    },
    runtime: {
      compHash: "comp-a",
      currentWindowId: "window-2",
      effectiveTokenLimit: 190_000,
      previousWindowId: "window-1",
      requestSchemaVersion: 1,
      windowNumber: 2,
    },
    schema: "clanker.codex-provider/checkpoint",
    sourceTokens: 123,
    version: 1,
  };
};

const parseKind = (value: unknown) => {
  const parsed = parseCheckpoint(value);
  return parsed.ok ? "ok" : "invalid";
};

const mutate = (
  change: (checkpoint: ReturnType<typeof validCheckpoint>) => void
) => {
  const checkpoint = structuredClone(validCheckpoint());
  change(checkpoint);
  return checkpoint;
};

const entry = (id: string, value: Record<string, unknown>): SessionEntry =>
  ({
    id,
    parentId: null,
    timestamp: "2026-07-30T12:34:56.000Z",
    ...value,
  }) as SessionEntry;

describe("checkpoint protocol", () => {
  it("canonicalizes, hashes, parses immutably, and compares compatibility", () => {
    const source = validCheckpoint();
    const parsed = parseCheckpoint(source);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    expect({
      canonical: canonicalJson(
        Object.fromEntries([
          ["b", 2],
          ["a", 1],
        ])
      ),
      frozen: Object.isFrozen(parsed.checkpoint.replacement),
      hash: sha256Canonical(
        Object.fromEntries([
          ["b", 2],
          ["a", 1],
        ])
      ),
      inputWasNotFrozen: !Object.isFrozen(source),
      parsedWasCloned: parsed.checkpoint !== source,
    }).toStrictEqual({
      canonical: '{"a":1,"b":2}',
      frozen: true,
      hash: "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
      inputWasNotFrozen: true,
      parsedWasCloned: true,
    });

    expect([
      decideCheckpointCompatibility(parsed.checkpoint, {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/",
        provider: "openai-codex",
      }),
      decideCheckpointCompatibility(parsed.checkpoint, {
        api: "openai-codex-responses",
        baseUrl: "https://other.invalid/backend-api",
        provider: "openai-codex",
      }),
      decideCheckpointCompatibility(parsed.checkpoint, {
        api: "different-api",
        baseUrl: "https://chatgpt.com/backend-api",
        provider: "openai-codex",
      }),
      decideCheckpointCompatibility(parsed.checkpoint, {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        provider: "different-provider",
      }),
    ]).toStrictEqual([
      { compatible: true },
      { compatible: false, field: "baseUrl" },
      { compatible: false, field: "api" },
      { compatible: false, field: "provider" },
    ]);
  });

  it("rejects corrupt, forbidden, non-canonical, and sensitive data", () => {
    const invalidCases: [string, unknown][] = [
      [
        "unknown top-level key",
        { ...validCheckpoint(), authorization: "Bearer secret" },
      ],
      [
        "unknown identity metadata",
        mutate((value) => {
          Object.assign(value.identity, { accountId: "sensitive" });
        }),
      ],
      [
        "blank model",
        mutate((value) => {
          value.identity.model = " ";
        }),
      ],
      [
        "non-canonical base URL",
        mutate((value) => {
          value.identity.baseUrl = "https://chatgpt.com/backend-api/";
        }),
      ],
      [
        "negative number",
        mutate((value) => {
          value.sourceTokens = -1;
        }),
      ],
      [
        "non-finite number",
        mutate((value) => {
          value.response.usage.input = Number.POSITIVE_INFINITY;
        }),
      ],
      [
        "missing usage",
        {
          ...validCheckpoint(),
          response: { id: "resp_without_usage" },
        },
      ],
      [
        "fractional number",
        mutate((value) => {
          value.sourceTokens = 0.5;
        }),
      ],
      [
        "replacement hash",
        mutate((value) => {
          value.replacementSha256 = "0".repeat(64);
        }),
      ],
      [
        "missing compaction",
        mutate((value) => {
          value.replacement = [user()];
        }),
      ],
      [
        "multiple compactions",
        mutate((value) => {
          value.replacement = [compaction("one"), compaction("two")];
        }),
      ],
      [
        "non-final compaction",
        mutate((value) => {
          value.replacement = [compaction(), user()];
        }),
      ],
      [
        "compaction alias is not persisted",
        mutate((value) => {
          value.replacement = [
            user(),
            { ...compaction(), type: "compaction_summary" },
          ];
        }),
      ],
      [
        "empty compaction",
        mutate((value) => {
          value.replacement = [user(), compaction("")];
        }),
      ],
      [
        "sensitive compaction metadata",
        mutate((value) => {
          value.replacement = [
            user(),
            {
              ...compaction(),
              internal_chat_message_metadata_passthrough: {
                account_id: "sensitive",
                turn_id: "turn-1",
              },
            },
          ];
        }),
      ],
      [
        "provider-only compaction metadata",
        mutate((value) => {
          value.replacement = [
            user(),
            { ...compaction(), metadata: { provider_only: true } },
          ];
        }),
      ],
      [
        "trigger",
        mutate((value) => {
          value.replacement = [user(), { type: "compaction_trigger" }];
        }),
      ],
      [
        "assistant",
        mutate((value) => {
          value.replacement = [{ ...user(), role: "assistant" }, compaction()];
        }),
      ],
      [
        "tool item",
        mutate((value) => {
          value.replacement = [
            { call_id: "call-1", type: "function_call_output" },
            compaction(),
          ];
        }),
      ],
      [
        "user metadata",
        mutate((value) => {
          value.replacement = [
            { ...user(), internal_chat_message_metadata_passthrough: {} },
            compaction(),
          ];
        }),
      ],
      [
        "inline image",
        mutate((value) => {
          value.replacement = [
            {
              content: [
                {
                  image_url: "data:image/png;base64,AA",
                  type: "input_image",
                },
              ],
              role: "user",
              type: "message",
            },
            compaction(),
          ];
        }),
      ],
      [
        "remote image",
        mutate((value) => {
          value.replacement = [
            {
              content: [
                {
                  image_url: "https://example.invalid/image.png",
                  type: "input_image",
                },
              ],
              role: "user",
              type: "message",
            },
            compaction(),
          ];
        }),
      ],
    ];

    expect(
      invalidCases
        .filter(([, value]) => parseKind(value) !== "invalid")
        .map(([name]) => name)
    ).toStrictEqual([]);
    expect(parseKind({ ...validCheckpoint(), version: 0 })).toBe("invalid");
    expect(parseKind({ ...validCheckpoint(), version: 4 })).toBe("invalid");
    const { runtime: _, ...missingRuntime } = validCheckpoint();
    expect(parseKind(missingRuntime)).toBe("invalid");
  });

  it("resolves only the newest active-branch compaction boundary", () => {
    const first = validCheckpoint();
    first.response.id = "resp_first";
    const second = validCheckpoint();
    second.response.id = "resp_second";
    const inline = entry("inline", {
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: first,
      type: "custom",
    });
    const message = entry("message", {
      message: { content: "tail", role: "user", timestamp: 1 },
      type: "message",
    });
    const lifecycle = entry("lifecycle", {
      details: {
        checkpoint: second,
        type: CHECKPOINT_CUSTOM_TYPE,
      },
      firstKeptEntryId: "message",
      summary: "opaque",
      tokensBefore: 10,
      type: "compaction",
    });
    const fallback = entry("fallback", {
      firstKeptEntryId: "message",
      summary: "ordinary Pi summary",
      tokensBefore: 20,
      type: "compaction",
    });
    const corrupt = entry("corrupt", {
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: { ...second, version: 9 },
      type: "custom",
    });
    const corruptLifecycle = entry("corrupt-lifecycle", {
      details: {
        checkpoint: { ...second, version: 9 },
        type: CHECKPOINT_CUSTOM_TYPE,
      },
      firstKeptEntryId: "message",
      summary: "opaque",
      tokensBefore: 10,
      type: "compaction",
    });

    const native = resolveActiveCheckpointBoundary([
      inline,
      message,
      lifecycle,
      message,
    ]);
    const disabled = resolveActiveCheckpointBoundary([
      inline,
      lifecycle,
      fallback,
      message,
    ]);
    const invalid = resolveActiveCheckpointBoundary([inline, message, corrupt]);
    const invalidLifecycle = resolveActiveCheckpointBoundary([
      inline,
      corruptLifecycle,
    ]);
    expect({
      disabled: disabled.kind,
      forkBeforeCheckpoint: resolveActiveCheckpointBoundary([message]).kind,
      invalid: {
        carrier:
          invalid.kind === "invalid-checkpoint" ? invalid.carrier : undefined,
        kind: invalid.kind,
      },
      invalidLifecycle: {
        carrier:
          invalidLifecycle.kind === "invalid-checkpoint"
            ? invalidLifecycle.carrier
            : undefined,
        kind: invalidLifecycle.kind,
      },
      native: {
        carrier: native.kind === "checkpoint" ? native.carrier : undefined,
        responseId:
          native.kind === "checkpoint"
            ? native.checkpoint.response.id
            : undefined,
        tailLength: native.kind === "checkpoint" ? native.tail.length : -1,
      },
    }).toStrictEqual({
      disabled: "pi-compaction",
      forkBeforeCheckpoint: "none",
      invalid: { carrier: "inline", kind: "invalid-checkpoint" },
      invalidLifecycle: {
        carrier: "lifecycle",
        kind: "invalid-checkpoint",
      },
      native: {
        carrier: "lifecycle",
        responseId: "resp_second",
        tailLength: 1,
      },
    });
  });

  it("uses inline local fallback only across authoritative Pi history", () => {
    const kept = entry("kept", {
      message: { content: "kept", role: "user", timestamp: 1 },
      type: "message",
    });
    const inline = entry("inline", {
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: validCheckpoint(),
      type: "custom",
    });
    const lifecycle = (summary: string, firstKeptEntryId = kept.id) =>
      entry("lifecycle", {
        details: {
          checkpoint: validCheckpoint(),
          type: CHECKPOINT_CUSTOM_TYPE,
        },
        firstKeptEntryId,
        summary,
        tokensBefore: 10,
        type: "compaction",
      });
    const readable = lifecycle("  readable portable summary  ");
    const blank = lifecycle(" \n ");
    const unresolved = lifecycle("readable", "missing");
    const corrupt = lifecycle("readable");
    if (corrupt.type === "compaction") {
      corrupt.details = {
        checkpoint: { ...validCheckpoint(), version: 9 },
        type: CHECKPOINT_CUSTOM_TYPE,
      };
    }

    const cases = [
      [[], true],
      [[kept, readable], true],
      [[kept, blank], false],
      [[kept, unresolved], false],
      [[kept, corrupt], false],
    ] as const;

    expect(
      cases.map(([prefix]) =>
        canUseInlineLocalFallback([...prefix, inline], prefix.length)
      )
    ).toStrictEqual(cases.map(([, expected]) => expected));
    expect(
      cases
        .slice(1)
        .map(([prefix]) =>
          isPortableLifecycleCompaction(prefix, prefix.length - 1)
        )
    ).toStrictEqual(cases.slice(1).map(([, expected]) => expected));
  });

  it("parses runtime state and applies comp-hash compatibility", () => {
    const source = validCheckpoint();
    const agent = {
      author: "assistant",
      content: [{ text: "delegated result", type: "input_text" }],
      recipient: "user",
      type: "agent_message",
    };
    source.replacement = [user(), agent, compaction()];
    source.replacementSha256 = sha256Canonical(source.replacement);
    const parsed = parseCheckpoint(source);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const incompatible = structuredClone(source);
    (incompatible.runtime as Record<string, unknown>).extra = true;

    expect({
      incompatible: parseKind(incompatible),
      matchingHash: decideCheckpointCompatibility(parsed.checkpoint, {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        compHash: "comp-a",
        provider: "openai-codex",
      }),
      mismatchedHash: decideCheckpointCompatibility(parsed.checkpoint, {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        compHash: "comp-b",
        provider: "openai-codex",
      }),
      version: parsed.checkpoint.version,
    }).toStrictEqual({
      incompatible: "invalid",
      matchingHash: { compatible: true },
      mismatchedHash: { compatible: false, field: "compHash" },
      version: 1,
    });
  });
});
