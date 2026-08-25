import { describe, expect, it } from "vite-plus/test";

import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_SCHEMA,
  nativeCheckpointSummary,
  sha256Canonical,
} from "../checkpoint.js";
import type { CodexObservation } from "../observability.js";
import { formatCodexProviderStatus } from "../status.js";
import { sessionEntry as createSessionEntry } from "./fixtures.js";
import type { SessionEntryPayload } from "./fixtures.js";

const sessionEntry = <const Payload extends SessionEntryPayload>(
  id: string,
  value: Payload,
  parentId: string | null = null,
) => createSessionEntry(id, value, parentId, `2026-08-04T12:00:0${id.at(-1) ?? "0"}.000Z`);

const EMPTY_OBSERVABILITY = {
  observabilityPath: ":memory:",
  observations: [] as const,
};

const requestObservation = (
  timestamp: number,
  cacheReadTokens: number,
  inputItemHashes: string[],
  fellBackToSse = false,
): CodexObservation => ({
  data: {
    model: "gpt-5.3-codex",
    outcome: "stop",
    request: {
      cacheEnabled: true,
      cacheKeyHash: "cache-key-hash",
      inputItemHashes,
      instructionsHash: "instructions-hash",
      stableRequestHash: "stable-request-hash",
      toolsHash: "tools-hash",
    },
    response: {
      cacheReadTokens,
      cacheWriteTokens: 0,
      inputTokens: 100,
    },
    transport: { configured: "auto", fellBackToSse },
  },
  kind: "request",
  timestamp,
});

const checkpoint = (
  responseId: string,
  reason: "manual" | "threshold",
  phase: "pre-sampling" | "standalone",
  sourceTokens: number,
) => {
  const replacement = [
    {
      encrypted_content: `encrypted-${responseId}`,
      type: "compaction",
    },
  ];
  return {
    identity: {
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.3-codex",
      provider: "openai-codex",
    },
    phase,
    protocol: CHECKPOINT_PROTOCOL,
    reason,
    replacement,
    replacementSha256: sha256Canonical(replacement),
    response: {
      id: responseId,
      usage: {
        cacheRead: 20,
        cacheWrite: 0,
        input: 100,
        output: 10,
        totalTokens: 130,
      },
    },
    runtime: {
      compHash: "comp-a",
      currentWindowId: `window-${responseId}`,
      effectiveTokenLimit: 250_000,
      previousWindowId: null,
      requestSchemaVersion: 1,
      windowNumber: Number(responseId.at(-1)),
    },
    schema: CHECKPOINT_SCHEMA,
    sourceTokens,
    version: 1,
  };
};

describe("Codex provider status", () => {
  it("reports current state and deduplicates checkpoint carriers", () => {
    const first = checkpoint("response-1", "manual", "standalone", 1000);
    const second = checkpoint("response-2", "threshold", "pre-sampling", 2000);
    const inline = sessionEntry("1", {
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: first,
      type: "custom",
    });
    const duplicateLifecycle = sessionEntry(
      "2",
      {
        details: { checkpoint: first, type: CHECKPOINT_CUSTOM_TYPE },
        firstKeptEntryId: "1",
        summary: nativeCheckpointSummary(first.runtime.currentWindowId),
        tokensBefore: 1000,
        type: "compaction",
      },
      "1",
    );
    const active = sessionEntry(
      "3",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: second,
        type: "custom",
      },
      "2",
    );
    const report = formatCodexProviderStatus({
      branch: [inline, duplicateLifecycle, active],
      current: {
        autoCompactTokens: 244_800,
        contextUsage: {
          contextWindow: 272_000,
          percent: 4.5,
          tokens: 12_345,
        },
        identity: {
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api/",
          compHash: "comp-a",
          provider: "openai-codex",
        },
        model: "gpt-5.3-codex",
        reasoning: "high",
      },
      entries: [inline, duplicateLifecycle, active],
      ...EMPTY_OBSERVABILITY,
      sessionId: "session-main",
    });

    for (const value of [
      "  Model: gpt-5.3-codex · reasoning high",
      "Session: session-main",
      "  Context: 12,345 / 272,000 tokens (4.5%) · compaction threshold 244,800",
      "  Checkpoint: valid · compatible · provider window 2 · checkpoint entry",
      "  Count: 2 current branch · 2 session",
      "  Latest (current branch): ~2,000 →",
      "reduced by ~",
      "  Recent (current branch, max 3):",
      "  Estimated volume (session): ~3,000 source →",
      "  OpenAI usage (session): 260 total · 200 uncached input · 40 cache read",
      "  Triggers (session): manual 1, automatic threshold 1",
      "Timing: between turns 1, before reply 1",
    ]) {
      expect(report).toContain(value);
    }
  });

  it("reports invalid active checkpoints without exposing payloads", () => {
    const invalid = sessionEntry("1", {
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: { secret: "CHECKPOINT_SECRET" },
      type: "custom",
    });
    const report = formatCodexProviderStatus({
      branch: [invalid],
      entries: [invalid],
      ...EMPTY_OBSERVABILITY,
      sessionId: "session-diagnostics",
    });

    for (const value of [
      "  Checkpoint: invalid · checkpoint entry",
      "  Invalid checkpoint entries: 1 current branch · 1 session",
      "  Replay blocks: 0 session",
      "  Transport fallbacks: 0 session",
    ]) {
      expect(report).toContain(value);
    }
    expect(report).not.toContain("CHECKPOINT_SECRET");
  });

  it("explains cache misses from SQLite request observations", () => {
    const observations: CodexObservation[] = [
      requestObservation(61_000, 0, ["a", "b", "c"], true),
      requestObservation(1000, 100, ["a", "b"]),
      {
        data: {
          baseline: { messageCount: 3 },
          event: { messageCount: 4 },
          frameResult: "missing",
        },
        kind: "context-frame-failure",
        timestamp: 62_000,
      },
      {
        data: {
          outcome: "error",
          transport: { configured: "websocket", fellBackToSse: true },
        },
        kind: "compaction",
        timestamp: 63_000,
      },
    ];

    const report = formatCodexProviderStatus({
      branch: [],
      entries: [],
      observabilityPath: "/tmp/codex-provider.sqlite",
      observations,
      sessionId: "session-observed",
    });

    for (const value of [
      "Cache",
      "  Latest: miss",
      "  Previous: hit 1m earlier",
      "  Input prefix: 2 matching items · 2 previous · 3 latest",
      "  Assessment: no client-visible cause",
      "  Replay blocks: 1 session",
      "  Transport fallbacks: 2 session",
      "  Failed compaction requests: 1 session",
      "  Database: /tmp/codex-provider.sqlite",
      "  Rows (session, 30 days): 2 requests · 1 compactions · 1 replay blocks",
    ]) {
      expect(report).toContain(value);
    }
  });

  it("separates the active branch from abandoned session history", () => {
    const active = checkpoint("response-1", "manual", "standalone", 1000);
    const abandoned = checkpoint("response-2", "threshold", "pre-sampling", 2000);
    const root = sessionEntry("1", {
      message: { content: "root", role: "user", timestamp: 1 },
      type: "message",
    });
    const branchCheckpoint = sessionEntry(
      "2",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: active,
        type: "custom",
      },
      "1",
    );
    const abandonedCheckpoint = sessionEntry(
      "3",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: abandoned,
        type: "custom",
      },
      "1",
    );

    const report = formatCodexProviderStatus({
      branch: [root, branchCheckpoint],
      entries: [root, branchCheckpoint, abandonedCheckpoint],
      ...EMPTY_OBSERVABILITY,
      sessionId: "session-branched",
    });

    expect(report).toContain("  Count: 1 current branch · 2 session");
    expect(report).toContain("  Latest (current branch): ~1,000 →");
    expect(report).toContain("  Estimated volume (session): ~3,000 source →");
  });

  it("bounds recent branch history to three timestamped compactions", () => {
    const branch = [1, 2, 3, 4].map((value) =>
      sessionEntry(String(value), {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: checkpoint(
          `response-${value}`,
          value % 2 === 0 ? "threshold" : "manual",
          value % 2 === 0 ? "pre-sampling" : "standalone",
          value * 1000,
        ),
        type: "custom",
      }),
    );
    const report = formatCodexProviderStatus({
      branch,
      entries: branch,
      ...EMPTY_OBSERVABILITY,
      sessionId: "session-recent",
    });
    const recent = report.split("\n").find((line) => line.includes("Recent (current branch"));

    expect(recent).not.toContain("12:00:01.000Z");
    expect(recent).toContain("12:00:02.000Z");
    expect(recent).toContain("12:00:03.000Z");
    expect(recent).toContain("12:00:04.000Z");
  });

  it("rejects lifecycle carriers with unexpected fields", () => {
    const malformed = sessionEntry("1", {
      details: {
        checkpoint: checkpoint("response-1", "manual", "standalone", 1000),
        secret: "CARRIER_SECRET",
        type: CHECKPOINT_CUSTOM_TYPE,
      },
      firstKeptEntryId: "root",
      summary: nativeCheckpointSummary("window-response-1"),
      tokensBefore: 1000,
      type: "compaction",
    });
    const report = formatCodexProviderStatus({
      branch: [malformed],
      entries: [malformed],
      ...EMPTY_OBSERVABILITY,
      sessionId: "session-malformed-carrier",
    });

    expect(report).toContain("Checkpoint: invalid · Pi compaction");
    expect(report).toContain("Count: 0 current branch · 0 session");
    expect(report).toContain("Invalid checkpoint entries: 1 current branch · 1 session");
    expect(report).not.toContain("CARRIER_SECRET");
  });
});
