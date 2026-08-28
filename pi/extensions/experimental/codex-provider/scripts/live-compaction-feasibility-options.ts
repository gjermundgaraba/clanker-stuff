import { ok as assert } from "node:assert/strict";
import { parseArgs } from "node:util";

export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const FEASIBILITY_ACKNOWLEDGEMENT = "I_ACCEPT_UP_TO_5_LIVE_COMPACTIONS";
export const FEASIBILITY_ACKNOWLEDGEMENT_ENV = "CODEX_COMPACTION_FEASIBILITY_ACK";
export const MAX_COMPACTION_REQUESTS = 5;
export const MAX_CONTROL_PERCENT = 115;
export const MAX_LOCAL_CANDIDATE_TOKENS = 325_000;
export const MAX_REQUEST_TIMEOUT_MS = 600_000;
export const OBSERVED_PROVIDER_TOKENS = 282_952;

export interface FeasibilityInvocation {
  readonly alternateModel: string;
  readonly candidateTokens: number;
  readonly showHelp: boolean;
  readonly timeoutMs: number;
}

export interface FeasibilityCase {
  readonly candidate: boolean;
  readonly id: "control" | "sol-sse-1" | "sol-sse-2" | "sol-ws" | "alternate";
  readonly model: "alternate" | "primary";
  readonly transport: "sse" | "websocket";
}

export const feasibilityCases = (): readonly FeasibilityCase[] => [
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
];

const withinControlRatio = (candidate: number, control: number): boolean =>
  candidate * 100 <= control * MAX_CONTROL_PERCENT;

export const assertCandidateWithinControlBounds = ({
  candidateEstimatedTokens,
  candidateSerializedBytes,
  controlEstimatedTokens,
  controlSerializedBytes,
}: {
  readonly candidateEstimatedTokens: number;
  readonly candidateSerializedBytes: number;
  readonly controlEstimatedTokens: number;
  readonly controlSerializedBytes: number;
}) => {
  assert(
    withinControlRatio(candidateEstimatedTokens, controlEstimatedTokens),
    `Candidate local estimate ${candidateEstimatedTokens} exceeds ${MAX_CONTROL_PERCENT / 100}x control ${controlEstimatedTokens}`,
  );
  assert(
    withinControlRatio(candidateSerializedBytes, controlSerializedBytes),
    `Candidate serialized input ${candidateSerializedBytes} bytes exceeds ${MAX_CONTROL_PERCENT / 100}x control ${controlSerializedBytes} bytes`,
  );
};

const positiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, `${name} must be a positive safe integer`);
  return parsed;
};

export const parseFeasibilityInvocation = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): FeasibilityInvocation => {
  const { values } = parseArgs({
    allowPositionals: false,
    args: args[0] === "--" ? args.slice(1) : [...args],
    options: {
      "alternate-model": { type: "string" },
      "candidate-tokens": { type: "string" },
      execute: { type: "boolean" },
      help: { type: "boolean" },
      "timeout-ms": { type: "string" },
    },
    strict: true,
  });
  const showHelp = values.help === true;
  const execute = values.execute === true;
  const alternateModel = values["alternate-model"] ?? "";
  const candidateTokens = positiveInteger(
    values["candidate-tokens"],
    OBSERVED_PROVIDER_TOKENS + 1,
    "--candidate-tokens",
  );
  const timeoutMs = positiveInteger(
    values["timeout-ms"],
    DEFAULT_REQUEST_TIMEOUT_MS,
    "--timeout-ms",
  );

  if (!showHelp) {
    assert(execute, "Live requests require --execute");
    assert(
      environment[FEASIBILITY_ACKNOWLEDGEMENT_ENV] === FEASIBILITY_ACKNOWLEDGEMENT,
      `Live requests require ${FEASIBILITY_ACKNOWLEDGEMENT_ENV}=${FEASIBILITY_ACKNOWLEDGEMENT}`,
    );
    assert(alternateModel.length > 0, "--alternate-model is required");
    assert(
      candidateTokens > OBSERVED_PROVIDER_TOKENS && candidateTokens <= MAX_LOCAL_CANDIDATE_TOKENS,
      `--candidate-tokens must be ${OBSERVED_PROVIDER_TOKENS + 1}–${MAX_LOCAL_CANDIDATE_TOKENS}`,
    );
    assert(
      timeoutMs <= MAX_REQUEST_TIMEOUT_MS,
      `--timeout-ms may not exceed ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }

  return {
    alternateModel,
    candidateTokens,
    showHelp,
    timeoutMs,
  };
};
