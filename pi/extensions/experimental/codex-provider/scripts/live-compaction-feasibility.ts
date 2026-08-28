#!/usr/bin/env node
import { ok as assert } from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  CodexCompactionRequest,
  CodexCompactionResult,
  CodexProviderRuntime,
} from "../provider.ts";
import { mergeRemoteCompactionFeatureHeader, REMOTE_COMPACTION_FEATURE } from "../lifecycle.ts";
import { estimateModelVisibleTokens, shrinkTrailingOutputs } from "../replay.ts";
import type { FeasibilityCase } from "./live-compaction-feasibility-options.ts";
import {
  assertCandidateWithinControlBounds,
  DEFAULT_REQUEST_TIMEOUT_MS,
  feasibilityCases,
  FEASIBILITY_ACKNOWLEDGEMENT,
  FEASIBILITY_ACKNOWLEDGEMENT_ENV,
  MAX_COMPACTION_REQUESTS,
  MAX_LOCAL_CANDIDATE_TOKENS,
  MAX_REQUEST_TIMEOUT_MS,
  OBSERVED_PROVIDER_TOKENS,
  parseFeasibilityInvocation,
} from "./live-compaction-feasibility-options.ts";
import {
  fetchRequestBody,
  fetchRequestUrl,
  isWireRecord as isRecord,
  parseCompactionRequestBody,
  StringValueSchema,
  WireValueSchema,
} from "./wire.ts";
import type { WireRecord, WireValue } from "./wire.ts";

const PRIMARY_MODEL = "gpt-5.6-sol";
const OUTPUT_CHUNKS = 32;
const MAX_PROVIDER_CASE_TOKENS = 325_000;
const EMPTY_CONTEXT: Context = { messages: [], tools: [] };
const TRAMPOLINE_STOP = "compaction feasibility trampoline complete";
const WebSocketProbeSchema = Type.Object({
  send: Type.Function([WireValueSchema], WireValueSchema),
});

type CompactionInput = NonNullable<CodexCompactionRequest["authoritativeInput"]>;
type CompactionInputItem = CompactionInput[number];
type SupportedModel = Model<"openai-codex-responses">;

interface ActiveRequest {
  readonly abort: AbortController;
  readonly caseId: FeasibilityCase["id"];
  readonly model: string;
  readonly transport: FeasibilityCase["transport"];
  claimed: boolean;
  socketConstructions: number;
}

const assertResponsesEndpoint = (
  value: string,
  transport: FeasibilityCase["transport"],
  caseId: FeasibilityCase["id"],
) => {
  const url = new URL(value);
  const expectedProtocols = transport === "sse" ? ["http:", "https:"] : ["ws:", "wss:"];
  assert(
    expectedProtocols.includes(url.protocol) && url.pathname.endsWith("/responses"),
    `${caseId}: unexpected ${transport} endpoint`,
  );
};

const assertCompactionHeaders = (headers: Headers, caseId: FeasibilityCase["id"]) => {
  assert(
    headers.get("x-openai-internal-codex-responses-lite") === "true",
    `${caseId}: request did not use Responses Lite`,
  );
  const features = (headers.get("x-codex-beta-features") ?? "")
    .split(",")
    .map((feature) => feature.trim().toLowerCase());
  assert(
    features.includes(REMOTE_COMPACTION_FEATURE.toLowerCase()),
    `${caseId}: request did not advertise ${REMOTE_COMPACTION_FEATURE}`,
  );
};

const websocketHeaders = (value: WireValue, caseId: FeasibilityCase["id"]) => {
  assert(isRecord(value) && isRecord(value.headers), `${caseId}: WebSocket headers are missing`);
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value.headers)) {
    assert(
      Value.Check(StringValueSchema, headerValue),
      `${caseId}: WebSocket header ${name} is malformed`,
    );
    headers.set(name, headerValue);
  }
  return headers;
};

export const installFeasibilityRequestBudget = () => {
  const nativeFetch = globalThis.fetch;
  const websocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const nativeWebSocket = globalThis.WebSocket;
  assert(
    nativeWebSocket !== undefined,
    "Native WebSocket support is required before any compaction request",
  );
  const cacheKeys = new Set<string>();
  const sessionIds = new Set<string>();
  const turnIds = new Set<string>();
  let requestCount = 0;
  let active: ActiveRequest | undefined;

  const abortRequest = (request: ActiveRequest, error: WireValue) => {
    request.abort.abort(error instanceof Error ? error : new Error(String(error)));
  };

  const claim = (request: WireRecord, transport: FeasibilityCase["transport"]) => {
    const current = active;
    assert(current !== undefined, "Unexpected compaction request");
    assert(
      current.transport === transport,
      `${current.caseId}: expected ${current.transport}, observed ${transport}`,
    );
    if (current.claimed) {
      const error = new Error(`${current.caseId}: a retry was blocked`);
      abortRequest(current, error);
      throw error;
    }
    if (requestCount >= MAX_COMPACTION_REQUESTS) {
      const error = new Error(`Compaction request budget exceeded ${MAX_COMPACTION_REQUESTS}`);
      abortRequest(current, error);
      throw error;
    }
    assert(
      request.model === current.model,
      `${current.caseId}: request model did not match refreshed metadata`,
    );
    const cacheKey = request.prompt_cache_key;
    const metadata = request.client_metadata;
    assert(
      Value.Check(StringValueSchema, cacheKey) && cacheKey.length > 0,
      `${current.caseId}: prompt cache key is missing`,
    );
    assert(isRecord(metadata), `${current.caseId}: session metadata is missing`);
    const sessionId = metadata.session_id;
    const turnId = metadata.turn_id;
    assert(
      Value.Check(StringValueSchema, sessionId) &&
        sessionId.length > 0 &&
        Value.Check(StringValueSchema, turnId) &&
        turnId.length > 0,
      `${current.caseId}: session metadata is missing`,
    );
    assert(
      !cacheKeys.has(cacheKey) && !sessionIds.has(sessionId) && !turnIds.has(turnId),
      `${current.caseId}: cache/session metadata was reused`,
    );
    cacheKeys.add(cacheKey);
    sessionIds.add(sessionId);
    turnIds.add(turnId);
    current.claimed = true;
    requestCount += 1;
  };

  globalThis.fetch = async (input, init) => {
    const current = active;
    const url = fetchRequestUrl(input);
    let request: WireRecord | undefined;
    try {
      request = parseCompactionRequestBody(await fetchRequestBody(input, init));
      if (request === undefined) {
        if (new URL(url).pathname.endsWith("/responses")) {
          throw new Error(`${current?.caseId ?? "unknown"}: non-compaction SSE request blocked`);
        }
      } else {
        assert(current !== undefined, "Unexpected compaction request");
        assertResponsesEndpoint(url, "sse", current.caseId);
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        assertCompactionHeaders(headers, current.caseId);
        claim(request, "sse");
      }
    } catch (error) {
      if (current !== undefined) {
        abortRequest(current, error);
      }
      throw error;
    }
    return await nativeFetch(input, init);
  };

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: new Proxy(nativeWebSocket, {
      construct(target, argumentsList) {
        const owner = active;
        assert(owner !== undefined, "Unexpected WebSocket construction");
        try {
          const url: WireValue = argumentsList[0];
          const options: WireValue = argumentsList[1];
          assert(
            Value.Check(StringValueSchema, url),
            `${owner.caseId}: WebSocket URL is malformed`,
          );
          assertResponsesEndpoint(url, "websocket", owner.caseId);
          assertCompactionHeaders(websocketHeaders(options, owner.caseId), owner.caseId);
          owner.socketConstructions += 1;
          if (owner.socketConstructions > 1) {
            throw new Error(`${owner.caseId}: a WebSocket retry was blocked`);
          }
        } catch (error) {
          abortRequest(owner, error);
          throw error;
        }
        const socket = Value.Parse(
          WebSocketProbeSchema,
          Reflect.construct(target, argumentsList, target),
        );
        const nativeSend = socket.send;
        Object.defineProperty(socket, "send", {
          configurable: true,
          value(data: WireValue) {
            try {
              assert(active === owner, `${owner.caseId}: WebSocket request outlived its case`);
              assert(
                Value.Check(StringValueSchema, data),
                `${owner.caseId}: WebSocket request frame is malformed`,
              );
              const request = parseCompactionRequestBody(data);
              assert(
                request !== undefined && request.type === "response.create",
                `${owner.caseId}: non-compaction WebSocket request blocked`,
              );
              const metadata = request.client_metadata;
              assert(
                isRecord(metadata) &&
                  metadata.ws_request_header_x_openai_internal_codex_responses_lite === "true",
                `${owner.caseId}: WebSocket request did not use Responses Lite`,
              );
              claim(request, "websocket");
            } catch (error) {
              abortRequest(owner, error);
              throw error;
            }
            return nativeSend.call(socket, data);
          },
          writable: true,
        });
        return socket;
      },
    }),
    writable: true,
  });

  return {
    begin(canaryCase: FeasibilityCase, model: string, abort: AbortController) {
      assert(active === undefined, "A compaction request is already active");
      active = {
        abort,
        caseId: canaryCase.id,
        claimed: false,
        model,
        socketConstructions: 0,
        transport: canaryCase.transport,
      };
    },
    end() {
      assert(active?.claimed === true, "Compaction request was not observed");
      active = undefined;
    },
    get requestCount() {
      return requestCount;
    },
    restore() {
      globalThis.fetch = nativeFetch;
      if (websocketDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "WebSocket");
      } else {
        Object.defineProperty(globalThis, "WebSocket", websocketDescriptor);
      }
    },
  };
};

export const createFeasibilityInput = (
  targetTokens: number,
  label = randomUUID(),
): CompactionInput => {
  const callIds = Array.from({ length: OUTPUT_CHUNKS }, (_, index) => `${label}-${index}`);
  const calls: CompactionInputItem[] = callIds.map((callId) => ({
    arguments: "{}",
    call_id: callId,
    id: `fc-${callId}`,
    name: "feasibility_payload",
    type: "function_call",
  }));
  const emptyOutputs: CompactionInputItem[] = callIds.map((callId) => ({
    call_id: callId,
    id: `out-${callId}`,
    output: "",
    type: "function_call_output",
  }));
  const baseline = estimateModelVisibleTokens("", [...calls, ...emptyOutputs]);
  assert(targetTokens > baseline, "Candidate token target is too small");
  const payloadTokens = targetTokens - baseline;
  const outputs: CompactionInputItem[] = callIds.map((callId, index) => {
    const tokens =
      Math.floor(payloadTokens / OUTPUT_CHUNKS) + (index < payloadTokens % OUTPUT_CHUNKS ? 1 : 0);
    return {
      call_id: callId,
      id: `out-${callId}`,
      output: randomBytes(tokens * 2).toString("hex"),
      type: "function_call_output",
    };
  });
  const input = [...calls, ...outputs];
  assert(
    estimateModelVisibleTokens("", input) === targetTokens,
    "Synthetic input did not match the fixed local estimate",
  );
  return input;
};

export const assertFeasibilityUsage = (
  canaryCase: FeasibilityCase,
  usage: Pick<CodexCompactionResult["usage"], "cacheRead" | "cacheWrite" | "input">,
): number => {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  assert(
    usage.cacheRead === 0,
    `${canaryCase.id}: fresh cache key unexpectedly read cached tokens`,
  );
  assert(
    promptTokens <= MAX_PROVIDER_CASE_TOKENS,
    `${canaryCase.id}: provider prompt ${promptTokens} exceeded the per-case stop limit ${MAX_PROVIDER_CASE_TOKENS}`,
  );
  if (canaryCase.candidate) {
    assert(
      promptTokens > OBSERVED_PROVIDER_TOKENS,
      `${canaryCase.id}: provider prompt ${promptTokens} did not exceed the observed ${OBSERVED_PROVIDER_TOKENS}; stop without resizing`,
    );
  }
  return promptTokens;
};

const serializedInputBytes = (input: CompactionInput): number =>
  Buffer.byteLength(JSON.stringify(input), "utf-8");

export const requireCompactionResult = (
  caseId: FeasibilityCase["id"],
  result: CodexCompactionResult | undefined,
  outer: Pick<AssistantMessage, "errorMessage" | "stopReason">,
): CodexCompactionResult => {
  if (result === undefined) {
    throw new Error(
      `${caseId}: ${outer.errorMessage ?? `compaction stopped with ${outer.stopReason}`}`,
    );
  }
  assert(
    outer.stopReason === "error" && outer.errorMessage === TRAMPOLINE_STOP,
    `${caseId}: compaction completed but the transport trampoline did not stop as expected`,
  );
  return result;
};

const runCompaction = async (
  runtime: CodexProviderRuntime,
  model: SupportedModel,
  apiKey: string,
  env: CodexCompactionRequest["env"],
  canaryCase: FeasibilityCase,
  input: CompactionInput,
  effectiveTokenLimit: number,
  signal: AbortSignal,
): Promise<CodexCompactionResult> => {
  let result: CodexCompactionResult | undefined;
  const outer = await runtime.provider
    .stream(model, EMPTY_CONTEXT, {
      apiKey,
      env,
      maxRetries: 0,
      onPayload: async () => {
        const headers: Record<string, string | null> = {};
        mergeRemoteCompactionFeatureHeader(headers);
        result = await runtime.compact({
          apiKey,
          authoritativeInput: input,
          context: EMPTY_CONTEXT,
          effectiveTokenLimit,
          env,
          headers,
          inputPrefix: [],
          model,
          phase: "standalone",
          reason: "manual",
          sessionId: `feasibility:${canaryCase.id}:${randomUUID()}`,
          signal,
          thinkingLevel: "medium",
        });
        throw new Error(TRAMPOLINE_STOP);
      },
      sessionId: `feasibility-trampoline:${canaryCase.id}:${randomUUID()}`,
      signal,
      transport: canaryCase.transport,
    })
    .result();
  return requireCompactionResult(canaryCase.id, result, outer);
};

const assertFreshLiteMetadata = (
  runtime: CodexProviderRuntime,
  model: SupportedModel,
  candidateTokens: number,
) => {
  const metadata = runtime.getModelMetadata(model.id);
  assert(metadata !== undefined, `${model.id}: refreshed metadata is missing`);
  assert(
    metadata.slug === model.id && metadata.use_responses_lite,
    `${model.id}: refreshed matching Responses Lite metadata is required`,
  );
  assert(
    Number.isSafeInteger(metadata.context_window) &&
      (metadata.context_window ?? 0) > 0 &&
      Number.isSafeInteger(metadata.max_context_window) &&
      (metadata.max_context_window ?? 0) > 0,
    `${model.id}: live context_window and max_context_window are required`,
  );
  assert(
    model.thinkingLevelMap?.medium === "medium",
    `${model.id}: live metadata must support medium reasoning`,
  );
  const percent = metadata.effective_context_window_percent;
  const hypotheticalContextOverride = Math.ceil((candidateTokens * 100) / percent);
  assert(
    hypotheticalContextOverride <= (metadata.max_context_window ?? 0),
    `${model.id}: candidate would exceed live max_context_window after the native effective-window percentage`,
  );
  const window = runtime.getModelWindow(model);
  assert(window !== undefined, `${model.id}: effective model window is missing`);
  return {
    candidateAboveEffectiveWindow: candidateTokens > window.effectiveWindowTokens,
    contextWindow: metadata.context_window,
    effectivePercent: percent,
    effectiveWindowTokens: window.effectiveWindowTokens,
    hypotheticalContextOverride,
    maxContextWindow: metadata.max_context_window,
  };
};

const printHelp = () => {
  console.log(`Bounded Responses Lite compaction feasibility smoke.

This command makes no request unless --execute and the exact acknowledgement are
both present. It runs a fixed five-case plan with no resizing or rejection search:
control SSE, two cold Sol SSE candidates, then (only after all three pass) one Sol
WebSocket candidate and one alternate-model SSE candidate.

Usage:
  ${FEASIBILITY_ACKNOWLEDGEMENT_ENV}=${FEASIBILITY_ACKNOWLEDGEMENT} \\
    vp run @clanker-stuff/codex-provider#test:live:feasibility -- \\
    --execute --candidate-tokens 290000 --alternate-model gpt-5.6-terra

Bounds:
  absolute candidate local-estimate cap: ${OBSERVED_PROVIDER_TOKENS + 1}–${MAX_LOCAL_CANDIDATE_TOKENS}
  actual admissibility: fresh metadata plus actual token/byte control ratios
  compaction requests: at most ${MAX_COMPACTION_REQUESTS}
  request timeout: ${DEFAULT_REQUEST_TIMEOUT_MS}ms default, ${MAX_REQUEST_TIMEOUT_MS}ms maximum
  provider per-case post-response stop: ${MAX_PROVIDER_CASE_TOKENS}
`);
};

export const runFeasibility = async (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const invocation = parseFeasibilityInvocation(args, environment);
  if (invocation.showHelp) {
    printHelp();
    return;
  }

  const [{ createCodexModelCatalog }, { CodexObservability }, { createCodexProviderRuntime }] =
    await Promise.all([
      import("../model-catalog.ts"),
      import("../observability.ts"),
      import("../provider.ts"),
    ]);
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const authModel = modelRuntime
    .getModels("openai-codex")
    .find((candidate) => candidate.api === "openai-codex-responses");
  assert(authModel !== undefined, "No installed OpenAI Codex model exists");
  const auth = await modelRuntime.getAuth(authModel);
  assert(auth?.auth.apiKey !== undefined, "OpenAI Codex auth is unavailable");

  const catalog = createCodexModelCatalog();
  await catalog.refreshModels({
    allowNetwork: true,
    credential: { env: auth.env, key: auth.auth.apiKey, type: "api_key" },
    force: true,
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    signal: AbortSignal.timeout(30_000),
    stored: undefined,
  });
  const remoteModels = catalog.getModels();
  const findModel = (id: string): SupportedModel => {
    const found = remoteModels.find((candidate) => candidate.id === id);
    assert(found !== undefined, `Fresh remote metadata omitted ${id}`);
    return auth.auth.baseUrl === undefined
      ? { ...found }
      : { ...found, baseUrl: auth.auth.baseUrl };
  };
  const primary = findModel(PRIMARY_MODEL);
  const alternate = findModel(invocation.alternateModel);
  assert(primary.id !== alternate.id, "--alternate-model must differ from gpt-5.6-sol");

  const observability = new CodexObservability(":memory:");
  const runtime = createCodexProviderRuntime(observability, () => false, catalog);
  const primaryMetadata = assertFreshLiteMetadata(runtime, primary, invocation.candidateTokens);
  const alternateMetadata = assertFreshLiteMetadata(runtime, alternate, invocation.candidateTokens);
  assert(
    invocation.candidateTokens > primaryMetadata.effectiveWindowTokens,
    `Candidate must be above Sol's live effective window (${primaryMetadata.effectiveWindowTokens})`,
  );

  const plan = feasibilityCases();
  assert(
    plan.length === MAX_COMPACTION_REQUESTS,
    "Feasibility plan must contain exactly five cases",
  );
  const plannedCases = plan.map((canaryCase) => ({
    canaryCase,
    input: createFeasibilityInput(invocation.candidateTokens),
  }));
  const [controlPlan] = plannedCases;
  assert(controlPlan !== undefined, "Feasibility control is missing");
  const controlInput = shrinkTrailingOutputs(
    controlPlan.input,
    "",
    primaryMetadata.effectiveWindowTokens,
  );
  const controlEstimatedTokens = estimateModelVisibleTokens("", controlInput);
  const controlSerializedBytes = serializedInputBytes(controlInput);
  for (const { canaryCase, input } of plannedCases) {
    if (!canaryCase.candidate) {
      continue;
    }
    assertCandidateWithinControlBounds({
      candidateEstimatedTokens: estimateModelVisibleTokens("", input),
      candidateSerializedBytes: serializedInputBytes(input),
      controlEstimatedTokens,
      controlSerializedBytes,
    });
  }
  console.log(
    JSON.stringify({
      alternate: { id: alternate.id, ...alternateMetadata },
      bounds: {
        maxCompactionRequests: MAX_COMPACTION_REQUESTS,
        maxLocalCandidateTokens: MAX_LOCAL_CANDIDATE_TOKENS,
        maxProviderCaseTokens: MAX_PROVIDER_CASE_TOKENS,
        timeoutMs: invocation.timeoutMs,
      },
      candidateLocalTokens: invocation.candidateTokens,
      candidateSerializedBytes: serializedInputBytes(controlPlan.input),
      controlLocalTokens: controlEstimatedTokens,
      controlSerializedBytes,
      primary: { id: primary.id, ...primaryMetadata },
      type: "preflight",
    }),
  );

  const budget = installFeasibilityRequestBudget();
  let cumulativeProviderTokens = 0;
  try {
    for (const { canaryCase, input } of plannedCases) {
      const model = canaryCase.model === "primary" ? primary : alternate;
      const effectiveTokenLimit = canaryCase.candidate
        ? invocation.candidateTokens
        : primaryMetadata.effectiveWindowTokens;
      const abort = new AbortController();
      const timeout = setTimeout(() => {
        abort.abort(new Error(`${canaryCase.id}: ${invocation.timeoutMs}ms timeout`));
      }, invocation.timeoutMs);
      budget.begin(canaryCase, model.id, abort);
      try {
        const result = await runCompaction(
          runtime,
          model,
          auth.auth.apiKey,
          auth.env,
          canaryCase,
          input,
          effectiveTokenLimit,
          abort.signal,
        );
        budget.end();
        const promptTokens = assertFeasibilityUsage(canaryCase, result.usage);
        cumulativeProviderTokens += promptTokens;
        assert(
          result.estimatedSourceTokens ===
            (canaryCase.candidate ? invocation.candidateTokens : controlEstimatedTokens),
          `${canaryCase.id}: local shrinking differed from preflight`,
        );
        console.log(
          JSON.stringify({
            cacheReadTokens: result.usage.cacheRead,
            case: canaryCase.id,
            cumulativeProviderTokens,
            estimatedSourceTokens: result.estimatedSourceTokens,
            model: model.id,
            providerPromptTokens: promptTokens,
            responseId: result.responseId,
            transport: canaryCase.transport,
            type: "case",
          }),
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    assert(
      budget.requestCount === MAX_COMPACTION_REQUESTS,
      "The complete smoke did not observe exactly five compaction requests",
    );
    console.log(
      JSON.stringify({
        compactionRequests: budget.requestCount,
        cumulativeProviderTokens,
        outcome: "feasibility-only",
        type: "complete",
      }),
    );
  } finally {
    budget.restore();
    observability.close();
  }
};

if (process.argv[1] === import.meta.filename) {
  try {
    await runFeasibility(process.argv.slice(2), process.env);
  } catch (error: unknown) {
    console.error(`FEASIBILITY STOP: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
