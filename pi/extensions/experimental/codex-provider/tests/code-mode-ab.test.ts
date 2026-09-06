import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vite-plus/test";

import { collectMetrics, formatResult, summarize } from "../evals/code-mode-ab.ts";
import { emptyMetrics, nativeMetrics } from "../evals/native-exec.ts";

type Variant = Parameters<typeof summarize>[0][number];

const variant = (mode: Variant["mode"], estimatedCostUsd: number | null): Variant => ({
  activeTools: [],
  evaluation: { fail: 0, output: "", pass: 1, passed: true, protectedFilesIntact: true, tests: 1 },
  metrics: { ...emptyMetrics(), estimatedCostUsd, elapsedMs: 1000 },
  mode,
  trial: 1,
  workspace: "/fixture",
});

describe("Code Mode comparison metrics", () => {
  test("sums Pi per-response estimates without repricing accumulated tokens", () => {
    const response: AssistantMessage = {
      api: "openai-codex-responses",
      content: [],
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      role: "assistant",
      stopReason: "stop",
      timestamp: 0,
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0.75, output: 0.03, total: 0.78 },
        input: 150_000,
        output: 1000,
        totalTokens: 151_000,
      },
    };
    const pi = collectMetrics([response, response], 50, 10);
    const native = nativeMetrics(
      [{ type: "turn.completed", usage: { input_tokens: 300_000, output_tokens: 2000 } }],
      50,
      10,
    );

    expect(pi.estimatedCostUsd).toBeCloseTo(1.56, 12);
    expect(pi.assistantTurns).toBe(2);
    expect(pi.usage).toStrictEqual(native.usage);
    expect(native.estimatedCostUsd).toBeNull();
    expect(collectMetrics([], 0, null).estimatedCostUsd).toBe(0);
    expect(emptyMetrics().estimatedCostUsd).toBeNull();
  });

  test("keeps Pi cost comparisons but reports native cost as unavailable", () => {
    const results = [
      variant("direct", 1),
      variant("direct", 3),
      variant("code", 1),
      variant("native", null),
    ];
    const report = summarize(results);

    expect(report.byMode.direct?.averageEstimatedCostUsd).toBe(2);
    expect(report.byMode.code?.averageEstimatedCostUsd).toBe(1);
    expect(report.byMode.native?.averageEstimatedCostUsd).toBeNull();
    expect(report.codeModeDeltaPercent.estimatedCost).toBe(-50);
    expect(report.nativeCodexDeltaPercent.estimatedCost).toBeNull();
    expect(report.nativeCodexDeltaPercent.elapsed).toBe(0);
    expect(report.byMode.direct).not.toHaveProperty("averageCostUsd");
    expect(report.codeModeDeltaPercent).not.toHaveProperty("cost");
    const json = JSON.stringify({ comparison: report, results });
    expect(json).toContain('"estimatedCostUsd":null');
    expect(json).toContain('"averageEstimatedCostUsd":null');
    expect(json).not.toContain('"costUsd"');
  });

  test.each(["code", "direct"] as const)(
    "does not discard unknown %s costs when averaging runs or computing deltas",
    (missingMode) => {
      const report = summarize([
        variant("direct", 2),
        variant("code", 1),
        variant(missingMode, null),
        variant("native", null),
      ]);

      expect(report.byMode[missingMode]?.averageEstimatedCostUsd).toBeNull();
      expect(report.codeModeDeltaPercent.estimatedCost).toBeNull();
      expect(report.nativeCodexDeltaPercent.estimatedCost).toBeNull();
    },
  );

  test("preserves a genuine zero estimate without dividing by a zero baseline", () => {
    const results = [variant("direct", 2), variant("code", 0), variant("native", null)];
    const report = summarize(results);
    expect(report.byMode.code?.averageEstimatedCostUsd).toBe(0);
    expect(report.codeModeDeltaPercent.estimatedCost).toBe(-100);
    const zeroBaseline = summarize([variant("direct", 0), variant("code", 1)]);
    expect(zeroBaseline.byMode.direct?.averageEstimatedCostUsd).toBe(0);
    expect(zeroBaseline.codeModeDeltaPercent.estimatedCost).toBeNull();
  });

  test("reports missing modes as unavailable rather than emitting NaN", () => {
    const report = summarize([]);
    expect(report.byMode.direct).toStrictEqual({
      averageElapsedMs: null,
      averageEstimatedCostUsd: null,
      averageOutputTokens: null,
      averageTotalTokens: null,
      passRate: null,
    });
    expect(report.codeModeDeltaPercent.estimatedCost).toBeNull();
    expect(report.nativeCodexDeltaPercent.estimatedCost).toBeNull();
  });

  test("formats unknown costs as N/A without hiding genuine zero estimates", () => {
    expect(formatResult(variant("native", null)).estimatedCostUsd).toBe("N/A");
    expect(formatResult(variant("direct", 0)).estimatedCostUsd).toBe("0.0000");
    expect(formatResult(variant("code", 1.23456)).estimatedCostUsd).toBe("1.2346");
  });
});
