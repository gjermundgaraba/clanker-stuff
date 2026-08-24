import { describe, expect, it } from "vite-plus/test";

import { sha256Canonical } from "../checkpoint.js";
import { formatCheckpointEntry } from "../renderer.js";

const checkpoint = () => {
  const replacement = [
    {
      content: [{ text: "retained user", type: "input_text" }],
      role: "user",
      type: "message",
    },
    {
      encrypted_content: "SECRET_ENCRYPTED_CONTENT",
      id: "SECRET_COMPACTION_ID",
      type: "compaction",
    },
  ];
  return {
    identity: {
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.6-sol",
      provider: "openai-codex",
    },
    phase: "mid-turn",
    protocol: "openai-responses-compaction-v2",
    reason: "threshold",
    replacement,
    replacementSha256: sha256Canonical(replacement),
    response: {
      id: "SECRET_RESPONSE_ID",
      usage: {
        cacheRead: 30,
        cacheWrite: 40,
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
    sourceTokens: 12_345,
    version: 1,
  };
};

describe("checkpoint entry renderer", () => {
  it("displays human-readable metrics and discloses no checkpoint internals", () => {
    const display = formatCheckpointEntry(checkpoint());
    const malformed = formatCheckpointEntry({
      encrypted_content: "SECRET_MALFORMED",
      version: 9,
    });

    expect({
      display,
      malformed,
      sensitiveValuesPresent: [
        "SECRET_ENCRYPTED_CONTENT",
        "SECRET_COMPACTION_ID",
        "SECRET_RESPONSE_ID",
      ].filter((value) => display?.includes(value)),
    }).toStrictEqual({
      display:
        "✓ Context compacted successfully · Model: gpt-5.6-sol\nEstimated context size: ~12,345 → ~47 tokens · ~12,298 fewer (99.6% smaller)\nTrigger: Automatic — context threshold reached · Timing: While the agent was working\nOpenAI compaction usage: 120 tokens total\nUsage breakdown: 100 uncached input · 30 cached input · 20 output · 40 cache write\nCheckpoint: saved and validated · Provider window: 2",
      malformed: undefined,
      sensitiveValuesPresent: [],
    });
  });

  it("shows technical checkpoint details only when expanded", () => {
    expect(formatCheckpointEntry(checkpoint(), true)).toBe(
      "✓ Context compacted successfully · Model: gpt-5.6-sol\nEstimated context size: ~12,345 → ~47 tokens · ~12,298 fewer (99.6% smaller)\nTrigger: Automatic — context threshold reached · Timing: While the agent was working\nOpenAI compaction usage: 120 tokens total\nUsage breakdown: 100 uncached input · 30 cached input · 20 output · 40 cache write\nCheckpoint: saved and validated · Provider window: 2\nCheckpoint details:\nResponse ID: SECRET_RESPONSE_ID\nWindow IDs: window-1 → window-2\nReplacement SHA-256: 55985697c985bfb82c3cd1f693ad3e60322676197b8fbf890ba6b38e8f7e2bd5\nCompaction hash: comp-a\nSchema: clanker.codex-provider/checkpoint v1 · openai-responses-compaction-v2 · request v1\nEffective token limit: 190,000\nReplacement: 2 items · 1 compaction · 1 user · 0 agent",
    );
  });
});
