import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE,
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_SCHEMA,
  sha256Canonical,
} from "../checkpoint.js";
import { CODEX_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE } from "../provider.js";
import { formatCodexProviderStatus } from "../status.js";

const sessionEntry = (
  id: string,
  value: Record<string, unknown>,
  parentId: string | null = null
): SessionEntry =>
  ({
    id,
    parentId,
    timestamp: `2026-08-04T12:00:0${id.at(-1) ?? "0"}.000Z`,
    ...value,
  }) as SessionEntry;

const checkpoint = (
  responseId: string,
  reason: "manual" | "threshold",
  phase: "pre-sampling" | "standalone",
  sourceTokens: number
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
        summary: "portable",
        tokensBefore: 1000,
        type: "compaction",
      },
      "1"
    );
    const active = sessionEntry(
      "3",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: second,
        type: "custom",
      },
      "2"
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

  it("reports invalid active checkpoints and only redacted diagnostics", () => {
    const frame = sessionEntry("1", {
      customType: CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE,
      data: {
        baseline: { messageCount: 3 },
        event: { messageCount: 4, secret: "EVENT_SECRET" },
        frameResult: "missing",
        kind: "context-frame",
        version: 1,
      },
      type: "custom",
    });
    const fallback = sessionEntry(
      "2",
      {
        message: {
          diagnostics: [
            {
              details: {
                configuredTransport: "websocket",
                secret: "TRANSPORT_SECRET",
              },
              timestamp: Date.UTC(2026, 7, 4, 12, 0, 2),
              type: CODEX_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE,
            },
          ],
          role: "assistant",
        },
        type: "message",
      },
      "1"
    );
    const invalid = sessionEntry(
      "3",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: { secret: "CHECKPOINT_SECRET" },
        type: "custom",
      },
      "2"
    );
    const obsoleteFrame = sessionEntry("4", {
      customType: CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE,
      data: {
        baseline: { messageCount: 99 },
        event: { messageCount: 99, secret: "VERSION_SECRET" },
        frameResult: "ambiguous",
        kind: "context-frame",
        version: 2,
      },
      type: "custom",
    });
    const report = formatCodexProviderStatus({
      branch: [frame, fallback, invalid],
      entries: [frame, fallback, invalid, obsoleteFrame],
      sessionId: "session-diagnostics",
    });

    for (const value of [
      "  Checkpoint: invalid · checkpoint entry",
      "  Invalid checkpoint entries: 1 current branch · 1 session",
      "  Replay blocks: 1 current branch · 1 session · latest on current branch: missing",
      "(3 baseline / 4 event messages)",
      "  Transport fallbacks: 1 current branch · 1 session · latest on current branch: websocket",
    ]) {
      expect(report).toContain(value);
    }
    expect(report).not.toMatch(
      /EVENT_SECRET|TRANSPORT_SECRET|CHECKPOINT_SECRET|VERSION_SECRET/u
    );
  });

  it("separates the active branch from abandoned session history", () => {
    const active = checkpoint("response-1", "manual", "standalone", 1000);
    const abandoned = checkpoint(
      "response-2",
      "threshold",
      "pre-sampling",
      2000
    );
    const root = sessionEntry("1", {
      message: { role: "user" },
      type: "message",
    });
    const branchCheckpoint = sessionEntry(
      "2",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: active,
        type: "custom",
      },
      "1"
    );
    const abandonedCheckpoint = sessionEntry(
      "3",
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: abandoned,
        type: "custom",
      },
      "1"
    );

    const report = formatCodexProviderStatus({
      branch: [root, branchCheckpoint],
      entries: [root, branchCheckpoint, abandonedCheckpoint],
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
          value * 1000
        ),
        type: "custom",
      })
    );
    const report = formatCodexProviderStatus({
      branch,
      entries: branch,
      sessionId: "session-recent",
    });
    const recent = report
      .split("\n")
      .find((line) => line.includes("Recent (current branch"));

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
      summary: "portable",
      tokensBefore: 1000,
      type: "compaction",
    });
    const report = formatCodexProviderStatus({
      branch: [malformed],
      entries: [malformed],
      sessionId: "session-malformed-carrier",
    });

    expect(report).toContain("Checkpoint: invalid · Pi compaction");
    expect(report).toContain("Count: 0 current branch · 0 session");
    expect(report).toContain(
      "Invalid checkpoint entries: 1 current branch · 1 session"
    );
    expect(report).not.toContain("CARRIER_SECRET");
  });
});
