import { describe, expect, it } from "vite-plus/test";

import {
  assertCandidateWithinControlBounds,
  feasibilityCases,
  FEASIBILITY_ACKNOWLEDGEMENT,
  FEASIBILITY_ACKNOWLEDGEMENT_ENV,
  MAX_COMPACTION_REQUESTS,
  parseFeasibilityInvocation,
} from "../scripts/live-compaction-feasibility-options.js";

const acknowledged = {
  [FEASIBILITY_ACKNOWLEDGEMENT_ENV]: FEASIBILITY_ACKNOWLEDGEMENT,
};

describe("live compaction feasibility guardrails", () => {
  it("defines the fixed gated five-request plan", () => {
    expect(feasibilityCases()).toStrictEqual([
      {
        candidate: false,
        id: "control",
        model: "primary",
        transport: "sse",
      },
      {
        candidate: true,
        id: "sol-sse-1",
        model: "primary",
        transport: "sse",
      },
      {
        candidate: true,
        id: "sol-sse-2",
        model: "primary",
        transport: "sse",
      },
      {
        candidate: true,
        id: "sol-ws",
        model: "primary",
        transport: "websocket",
      },
      {
        candidate: true,
        id: "alternate",
        model: "alternate",
        transport: "sse",
      },
    ]);
    expect(feasibilityCases()).toHaveLength(MAX_COMPACTION_REQUESTS);
  });

  it("requires the explicit execution acknowledgement and fixed bounds", () => {
    expect(() =>
      parseFeasibilityInvocation(
        ["--candidate-tokens", "290000", "--alternate-model", "gpt-5.6-terra"],
        acknowledged,
      ),
    ).toThrow("--execute");
    expect(() =>
      parseFeasibilityInvocation(
        ["--", "--execute", "--candidate-tokens", "290000", "--alternate-model", "gpt-5.6-terra"],
        {},
      ),
    ).toThrow(FEASIBILITY_ACKNOWLEDGEMENT_ENV);
    expect(() =>
      parseFeasibilityInvocation(
        ["--execute", "--candidate-tokens", "290000", "--alternate-model", "gpt-5.6-terra"],
        { [FEASIBILITY_ACKNOWLEDGEMENT_ENV]: "I_ACCEPT_SOMETHING_ELSE" },
      ),
    ).toThrow(FEASIBILITY_ACKNOWLEDGEMENT_ENV);
    expect(
      parseFeasibilityInvocation(
        ["--", "--execute", "--candidate-tokens", "290000", "--alternate-model", "gpt-5.6-terra"],
        acknowledged,
      ),
    ).toMatchObject({
      alternateModel: "gpt-5.6-terra",
      candidateTokens: 290_000,
      timeoutMs: 300_000,
    });
    expect(() =>
      parseFeasibilityInvocation(
        ["--execute", "--candidate-tokens", "325001", "--alternate-model", "gpt-5.6-terra"],
        acknowledged,
      ),
    ).toThrow("--candidate-tokens");
    expect(() =>
      parseFeasibilityInvocation(
        [
          "--execute",
          "--candidate-tokens",
          "290000",
          "--alternate-model",
          "gpt-5.6-terra",
          "--timeout-ms",
          "600001",
        ],
        acknowledged,
      ),
    ).toThrow("--timeout-ms");
  });

  it("normalizes one task-runner separator and rejects positionals", () => {
    expect(parseFeasibilityInvocation(["--", "--help"], {})).toMatchObject({
      showHelp: true,
    });
    expect(() => parseFeasibilityInvocation(["--", "--help", "unexpected"], {})).toThrow(
      "Unexpected argument",
    );
    expect(() => parseFeasibilityInvocation(["--unknown"], {})).toThrow("Unknown option");
  });

  it("rejects a candidate token ratio above 1.15", () => {
    expect(() =>
      assertCandidateWithinControlBounds({
        candidateEstimatedTokens: 116,
        candidateSerializedBytes: 115,
        controlEstimatedTokens: 100,
        controlSerializedBytes: 100,
      }),
    ).toThrow("Candidate local estimate");
  });

  it("rejects a candidate serialized-size ratio above 1.15", () => {
    expect(() =>
      assertCandidateWithinControlBounds({
        candidateEstimatedTokens: 115,
        candidateSerializedBytes: 116,
        controlEstimatedTokens: 100,
        controlSerializedBytes: 100,
      }),
    ).toThrow("Candidate serialized input");
  });

  it("accepts both ratios at exactly 1.15", () => {
    expect(() =>
      assertCandidateWithinControlBounds({
        candidateEstimatedTokens: 115,
        candidateSerializedBytes: 115,
        controlEstimatedTokens: 100,
        controlSerializedBytes: 100,
      }),
    ).not.toThrow();
  });
});
