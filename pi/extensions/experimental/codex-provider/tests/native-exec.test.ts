import { once } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vite-plus/test";

import { captureNativeOutput, emptyMetrics, nativeMetrics } from "../evals/native-exec.ts";
import type { NativeExecEvent } from "../evals/native-exec.ts";

describe("native Code Mode evaluation", () => {
  test("decodes split UTF-8 on both streams and frames events only on LF", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events: NativeExecEvent[] = [];
    const captured = captureNativeOutput({ stdout, stderr }, (event) => events.push(event));
    const completed = {
      type: "item.completed",
      item: { type: "agent_message", text: "€😀\u2028between\u2029lines" },
    };
    const raw = `startup warning\nnull\n${JSON.stringify(completed)}\n{"type":"turn.completed"}`;
    const errorText = "stderr: 🪶漢字";
    const finished = Promise.all([once(stdout, "end"), once(stderr, "end")]);
    for (const byte of Buffer.from(raw)) {
      stdout.write(Buffer.from([byte]));
    }
    for (const byte of Buffer.from(errorText)) {
      stderr.write(Buffer.from([byte]));
    }
    stdout.end();
    stderr.end();
    await finished;

    expect(events).toStrictEqual([completed]);
    captured.flush();
    expect(events).toStrictEqual([completed, { type: "turn.completed" }]);
    expect(captured.stdout).toBe(raw);
    expect(captured.stderr).toBe(errorText);
  });

  test("starts without a cost estimate until its source supplies one", () => {
    expect(emptyMetrics().estimatedCostUsd).toBeNull();
  });

  test.each([
    { source: "completed", events: [{ type: "turn.completed" }], stopReason: "stop" },
    { source: "failed", events: [{ type: "turn.failed" }], stopReason: "error" },
    { source: "empty", events: [], stopReason: "unknown" },
    { source: "unknown", events: [{ type: "unrecognized" }], stopReason: "unknown" },
  ])("leaves native cost unavailable for $source events", ({ events, stopReason }) => {
    const metrics = nativeMetrics(events, 50, null);

    expect(metrics.estimatedCostUsd).toBeNull();
    expect(metrics.stopReasons).toStrictEqual([stopReason]);
  });

  test("keeps large cumulative usage without inferring request costs", () => {
    const metrics = nativeMetrics(
      [
        {
          type: "turn.completed",
          usage: {
            input_tokens: 150_001,
            cached_input_tokens: 20_000,
            cache_write_input_tokens: 10_000,
            output_tokens: 10_000,
            reasoning_output_tokens: 2_000,
          },
        },
      ],
      50,
      10,
    );

    expect(metrics.estimatedCostUsd).toBeNull();
    expect(metrics.elapsedMs).toBe(50);
    expect(metrics.firstResponseMs).toBe(10);
    expect(metrics.usage).toStrictEqual({
      input: 120_001,
      cacheRead: 20_000,
      cacheWrite: 10_000,
      output: 10_000,
      reasoning: 2_000,
      totalTokens: 160_001,
    });
  });

  test("keeps native token normalization, latest completion and tool deduplication", () => {
    const item = { id: "call", type: "command_execution" };
    const metrics = nativeMetrics(
      [
        { type: "turn.completed", usage: { input_tokens: 100 } },
        { type: "item.started", item },
        { type: "item.completed", item },
        { type: "item.completed", item },
        { type: "turn.completed", usage: { input_tokens: 2, cached_input_tokens: 3 } },
      ],
      50,
      null,
    );

    expect(metrics.usage.input).toBe(0);
    expect(metrics.usage.totalTokens).toBe(2);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.stopReasons).toStrictEqual(["stop"]);
  });
});
