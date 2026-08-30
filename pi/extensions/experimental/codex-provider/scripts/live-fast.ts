import { ok as assert } from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const OPT_IN = "CODEX_FAST_LIVE_PAID";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_PAIRS = 1;
const DEFAULT_MAX_TOTAL_TOKENS = 40_000;
const DEFAULT_MAX_COST_USD = 5;
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_OUTPUT_TOKENS = 32;
const EXPECTED_OUTPUT_WORDS = 64;
const SYSTEM_PROMPT = "Follow the user's exact reply format. Do not use tools or add explanation.";
const USER_PROMPT =
  'Reply with exactly 64 repetitions of the word "SPEED", separated by single spaces.';
const EXPECTED_RESPONSE = Array.from({ length: EXPECTED_OUTPUT_WORDS }, () => "SPEED").join(" ");
const TIMING_KEYS = [
  "responses_duration_excl_engine_and_client_tool_time_ms",
  "engine_service_total_ms",
  "engine_iapi_ttft_total_ms",
  "engine_service_ttft_total_ms",
  "engine_iapi_tbt_across_engine_calls_ms",
  "engine_service_tbt_across_engine_calls_ms",
] as const;

type Mode = "off" | "on";
type ResponseCreateKind = "generation" | "prewarm";
type ResponseTerminalType =
  | "response.completed"
  | "response.done"
  | "response.failed"
  | "response.incomplete";
type TimingMetrics = Partial<Record<(typeof TIMING_KEYS)[number], number>>;

interface Invocation {
  readonly maxCostUsd: number;
  readonly maxTotalTokens: number;
  readonly model?: string;
  readonly out: string;
  readonly pairs: number;
  readonly seed: number;
  readonly timeoutMs: number;
}

interface Handshake {
  readonly originator: string | undefined;
  readonly routingHint: string | undefined;
  readonly timingMetricsRequested: string | undefined;
}

interface TerminalEvidence {
  readonly serviceTier: string;
  readonly status: string;
  readonly type: ResponseTerminalType;
}

interface ResponseTerminalEvidence {
  readonly generation: TerminalEvidence;
  readonly prewarm: TerminalEvidence;
}

interface Sample {
  readonly clientMs: {
    readonly firstResponse: number;
    readonly firstText: number;
    readonly lastText: number;
    readonly textStream: number;
    readonly total: number;
  };
  readonly costUsd: number;
  readonly mode: Mode;
  readonly pair: number;
  readonly rawWebSocketTiming: readonly TimingMetrics[];
  readonly responseTerminalEvidence: ResponseTerminalEvidence;
  readonly tokens: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly wire: {
    readonly cache: "disabled";
    readonly originator: "codex_cli_rs" | "pi";
    readonly requestedServiceTier: "absent" | "priority";
    readonly routingHint: string;
    readonly timingMetricsRequested: true;
  };
  readonly visibleWordsPerSecond: number;
  readonly wordsAtFirstText: number;
}

const WireValueSchema = Type.Unknown();
type WireValue = Static<typeof WireValueSchema>;
const JsonRecordSchema = Type.Record(Type.String(), WireValueSchema);
type JsonRecord = Static<typeof JsonRecordSchema>;
const StringSchema = Type.String();
const NumberSchema = Type.Number();
const WebSocketProbeSchema = Type.Object({
  addEventListener: Type.Function(
    [StringSchema, Type.Function([WireValueSchema], Type.Void())],
    Type.Void(),
  ),
  send: Type.Function([WireValueSchema], WireValueSchema),
});

const isRecord = (value: WireValue): value is JsonRecord => Value.Check(JsonRecordSchema, value);

const usageTokens = (message: AssistantMessage): number =>
  message.usage.totalTokens ||
  message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;

const assistantText = (message: AssistantMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

const completeSpeedWords = (text: string): number =>
  text.split(" ").filter((word) => word === "SPEED").length;

const parsePositiveInteger = (name: string, value: string): number => {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, `${name} must be a positive safe integer`);
  return parsed;
};

const parseNonnegativeNumber = (name: string, value: string): number => {
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed >= 0, `${name} must be a nonnegative finite number`);
  return parsed;
};

const parseUint32 = (name: string, value: string): number => {
  const parsed = Number(value);
  assert(
    Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff,
    `${name} must be an unsigned 32-bit integer`,
  );
  return parsed;
};

const defaultArtifactPath = () =>
  path.join(
    process.env.CODEX_FAST_LIVE_DIR?.trim() || os.tmpdir(),
    `codex-live-fast-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );

const parseInvocation = (args: readonly string[]): Invocation | undefined => {
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : [...args],
    options: {
      help: { type: "boolean" },
      "max-cost-usd": { type: "string" },
      "max-total-tokens": { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
      pairs: { type: "string" },
      seed: { type: "string" },
      "timeout-ms": { type: "string" },
    },
    strict: true,
  });
  if (values.help === true) {
    return undefined;
  }
  const maxCostUsd =
    values["max-cost-usd"] === undefined
      ? DEFAULT_MAX_COST_USD
      : parseNonnegativeNumber("--max-cost-usd", values["max-cost-usd"]);
  const maxTotalTokens =
    values["max-total-tokens"] === undefined
      ? DEFAULT_MAX_TOTAL_TOKENS
      : parsePositiveInteger("--max-total-tokens", values["max-total-tokens"]);
  const model = values.model ?? (process.env.CODEX_FAST_LIVE_MODEL?.trim() || undefined);
  assert(model === undefined || model.length > 0, "--model requires a value");
  assert(values.out === undefined || values.out.length > 0, "--out requires a value");
  const out = values.out === undefined ? defaultArtifactPath() : path.resolve(values.out);
  const pairs =
    values.pairs === undefined ? DEFAULT_PAIRS : parsePositiveInteger("--pairs", values.pairs);
  const seed =
    values.seed === undefined ? randomBytes(4).readUInt32LE() : parseUint32("--seed", values.seed);
  const timeoutMs =
    values["timeout-ms"] === undefined
      ? DEFAULT_TIMEOUT_MS
      : parsePositiveInteger("--timeout-ms", values["timeout-ms"]);
  assert(pairs <= 30, "--pairs is capped at 30 (60 paid generation requests)");
  return {
    maxCostUsd,
    maxTotalTokens,
    model,
    out,
    pairs,
    seed,
    timeoutMs,
  };
};

const help = `Usage:
  ${OPT_IN}=1 vp run @clanker-stuff/codex-provider#test:live:fast [options]

Paid, opt-in WebSocket throughput comparison with Fast Mode OFF and ON.
Every sample uses a fresh session and physical socket.

Options:
  --pairs N               Paired OFF/ON comparisons (default ${DEFAULT_PAIRS}, max 30)
  --seed N                Unsigned 32-bit request-order seed
  --model ID              Remote priority-capable model (default ${DEFAULT_MODEL})
  --out PATH              JSON artifact path (default: OS temp directory)
  --max-total-tokens N    Stop if completed usage exceeds the budget (default ${DEFAULT_MAX_TOTAL_TOKENS})
  --max-cost-usd N        Stop if completed reported cost exceeds the budget (default ${DEFAULT_MAX_COST_USD})
  --timeout-ms N          Per-request timeout (default ${DEFAULT_TIMEOUT_MS})
  --help                   Show this help without making requests

The harness sends 2 * pairs generation requests. Every fresh socket also sends
one generate=false prewarm, for 4 * pairs response.create frames in total. It is
intentionally excluded from the paid marathon. No prompt, credential, account
ID, or full header set is printed or written.`;

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

const randomizedOrders = (pairs: number, random: () => number): Mode[][] => {
  const orders = Array.from({ length: pairs }, (): Mode[] =>
    random() < 0.5 ? ["off", "on"] : ["on", "off"],
  );
  return orders;
};

const messageText = async (event: WireValue): Promise<string | undefined> => {
  const data = isRecord(event) ? event.data : undefined;
  if (Value.Check(StringSchema, data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  return undefined;
};

const timingMetrics = (value: WireValue): TimingMetrics | undefined => {
  if (
    !isRecord(value) ||
    value.type !== "responsesapi.websocket_timing" ||
    !isRecord(value.timing_metrics)
  ) {
    return undefined;
  }
  const sanitized: TimingMetrics = {};
  for (const key of TIMING_KEYS) {
    const candidate = value.timing_metrics[key];
    if (Value.Check(NumberSchema, candidate) && Number.isFinite(candidate) && candidate >= 0) {
      sanitized[key] = candidate;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

export const installWebSocketProbe = () => {
  const NativeWebSocket = globalThis.WebSocket;
  assert(NativeWebSocket !== undefined, "This live proof requires Node WebSocket support");
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const sockets = new Set<object>();
  let active:
    | {
        readonly handshakes: Handshake[];
        readonly metrics: TimingMetrics[];
        readonly pending: Promise<void>[];
        readonly responseCreateFrames: ResponseCreateKind[];
        readonly terminalResponses: {
          readonly messageSequence: number;
          readonly responseId: string | undefined;
          readonly serviceTier: string;
          readonly status: string;
          readonly type: ResponseTerminalType;
        }[];
      }
    | undefined;
  let messageSequence = 0;
  const ProbedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, argumentsList, newTarget) {
      assert(active !== undefined, "WebSocket constructed outside a sample");
      const observation = active;
      const [, options] = argumentsList;
      const headers = isRecord(options) && isRecord(options.headers) ? options.headers : {};
      observation.handshakes.push({
        originator: Value.Check(StringSchema, headers.originator) ? headers.originator : undefined,
        routingHint: Value.Check(StringSchema, headers["x-codex-routing-hint"])
          ? headers["x-codex-routing-hint"]
          : undefined,
        timingMetricsRequested: Value.Check(
          StringSchema,
          headers["x-responsesapi-include-timing-metrics"],
        )
          ? headers["x-responsesapi-include-timing-metrics"]
          : undefined,
      });
      const socket = Value.Parse(
        WebSocketProbeSchema,
        Reflect.construct(target, argumentsList, newTarget),
      );
      assert(!sockets.has(socket), "A physical WebSocket was reused");
      sockets.add(socket);
      const nativeSend = socket.send;
      Object.defineProperty(socket, "send", {
        configurable: true,
        value(data: WireValue) {
          if (Value.Check(StringSchema, data)) {
            try {
              const payload: WireValue = JSON.parse(data);
              if (isRecord(payload) && payload.type === "response.create") {
                observation.responseCreateFrames.push(
                  payload.generate === false ? "prewarm" : "generation",
                );
              }
            } catch {
              // The shipped provider remains authoritative for request parsing.
            }
          }
          return nativeSend.call(socket, data);
        },
        writable: true,
      });
      socket.addEventListener("message", (event: WireValue) => {
        messageSequence += 1;
        const currentMessageSequence = messageSequence;
        const pending = (async () => {
          const text = await messageText(event);
          if (text === undefined) {
            return;
          }
          try {
            const payload: WireValue = JSON.parse(text);
            const metric = timingMetrics(payload);
            if (metric !== undefined) {
              observation.metrics.push(metric);
            }
            if (
              isRecord(payload) &&
              (payload.type === "response.completed" ||
                payload.type === "response.done" ||
                payload.type === "response.incomplete" ||
                payload.type === "response.failed") &&
              isRecord(payload.response)
            ) {
              observation.terminalResponses.push({
                messageSequence: currentMessageSequence,
                responseId: Value.Check(StringSchema, payload.response.id)
                  ? payload.response.id
                  : undefined,
                serviceTier: Value.Check(StringSchema, payload.response.service_tier)
                  ? payload.response.service_tier
                  : "absent",
                status: Value.Check(StringSchema, payload.response.status)
                  ? payload.response.status
                  : "absent",
                type: payload.type,
              });
            }
          } catch {
            // The shipped provider remains authoritative for response parsing.
          }
        })();
        observation.pending.push(pending);
      });
      return socket;
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: ProbedWebSocket,
    writable: true,
  });
  return {
    begin() {
      assert(active === undefined, "A WebSocket sample is already active");
      active = {
        handshakes: [],
        metrics: [],
        pending: [],
        responseCreateFrames: [],
        terminalResponses: [],
      };
    },
    async finish() {
      assert(active !== undefined, "No WebSocket sample is active");
      const observation = active;
      await Promise.allSettled(observation.pending);
      active = undefined;
      return observation;
    },
    restore() {
      active = undefined;
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "WebSocket");
      } else {
        Object.defineProperty(globalThis, "WebSocket", original);
      }
    },
    socketCount: () => sockets.size,
  };
};

const context: Context = {
  messages: [{ content: USER_PROMPT, role: "user", timestamp: 0 }],
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
};

const run = async (invocation: Invocation) => {
  assert(process.env[OPT_IN] === "1", `Paid live requests are disabled. Re-run with ${OPT_IN}=1`);
  const [
    { createCodexModelCatalog, modelSupportsServiceTier },
    { CodexObservability },
    { createCodexProviderRuntime },
  ] = await Promise.all([
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
  assert(authModel !== undefined, "No OpenAI Codex model is installed");
  const auth = await modelRuntime.getAuth(authModel);
  assert(auth !== undefined, "OpenAI Codex auth is unavailable");
  const { apiKey } = auth.auth;
  assert(apiKey !== undefined, "OpenAI Codex auth is unavailable");

  const catalog = createCodexModelCatalog();
  await catalog.refreshModels({
    allowNetwork: true,
    credential: { env: auth.env, key: apiKey, type: "api_key" },
    force: true,
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    signal: AbortSignal.timeout(30_000),
    stored: undefined,
  });
  const priorityModels = catalog.getModels().filter((candidate) => {
    const metadata = catalog.getModelMetadata(candidate.id);
    return metadata !== undefined && modelSupportsServiceTier(metadata, "priority");
  });
  const modelId = invocation.model ?? DEFAULT_MODEL;
  const configuredModel = priorityModels.find(({ id }) => id === modelId);
  assert(
    configuredModel !== undefined,
    `Remote model ${modelId} is unavailable or does not advertise priority`,
  );
  const model: Model<"openai-codex-responses"> =
    auth.auth.baseUrl === undefined
      ? configuredModel
      : { ...configuredModel, baseUrl: auth.auth.baseUrl };

  let fastMode = false;
  const observability = new CodexObservability(":memory:");
  const runtime = createCodexProviderRuntime(observability, () => fastMode, catalog);
  const probe = installWebSocketProbe();
  const random = createRandom(invocation.seed);
  const orders = randomizedOrders(invocation.pairs, random);
  const samples: Sample[] = [];
  let responseCreateFrameCount = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;

  const takeSample = async (pair: number, mode: Mode): Promise<Sample> => {
    fastMode = mode === "on";
    const sessionId = `live-fast:${randomUUID()}`;
    const expectedTier = fastMode ? "priority" : undefined;
    const expectedHint = `model=${model.id}${fastMode ? ";tier=priority" : ""}`;
    const expectedOriginator = fastMode ? "codex_cli_rs" : "pi";
    let wireBodyObserved = false;
    let firstResponse: number | undefined;
    let firstText: number | undefined;
    let lastText: number | undefined;
    let message: AssistantMessage | undefined;
    let streamedText = "";
    let wordsAtFirstText: number | undefined;
    const started = performance.now();
    probe.begin();
    runtime.beginTurn(sessionId);
    try {
      const events = runtime.provider.stream(model, context, {
        apiKey,
        cacheRetention: "none",
        env: auth.env,
        headers: { "x-responsesapi-include-timing-metrics": "true" },
        maxRetries: 0,
        onPayload: (payload) => {
          assert(isRecord(payload), "Final provider payload is not an object");
          assert(
            payload.prompt_cache_key === undefined,
            "Cache-disabled request contains prompt_cache_key",
          );
          assert(payload.store === false, "Final provider payload must not store");
          if (expectedTier === undefined) {
            assert(
              !Object.hasOwn(payload, "service_tier"),
              "Fast OFF request contains service_tier",
            );
          } else {
            assert(
              payload.service_tier === expectedTier,
              "Fast ON request does not contain service_tier=priority",
            );
          }
          wireBodyObserved = true;
        },
        reasoningEffort: "none",
        sessionId,
        signal: AbortSignal.timeout(invocation.timeoutMs),
        textVerbosity: "low",
        timeoutMs: invocation.timeoutMs,
        toolChoice: "none",
        transport: "websocket",
      });
      for await (const event of events) {
        const elapsed = performance.now() - started;
        if (event.type === "start" && firstResponse === undefined) {
          firstResponse = elapsed;
        } else if (event.type === "text_delta" && event.delta.length > 0) {
          streamedText += event.delta;
          lastText = elapsed;
          if (firstText === undefined) {
            firstText = elapsed;
            wordsAtFirstText = completeSpeedWords(streamedText);
          }
        } else if (event.type === "done") {
          ({ message } = event);
        } else if (event.type === "error") {
          throw new Error(event.error.errorMessage ?? "Codex request failed");
        }
      }
    } finally {
      runtime.endTurn(sessionId);
      runtime.closeSession(sessionId);
    }
    const total = performance.now() - started;
    const observed = await probe.finish();
    assert(wireBodyObserved, "Final provider payload was not observed");
    assert(message !== undefined, "Codex request produced no final message");
    assert(
      message.responseId !== undefined && message.responseId.length > 0,
      "Final assistant message has no responseId",
    );
    assert(firstResponse !== undefined, "Codex request produced no first response");
    assert(firstText !== undefined, "Codex request produced no text");
    assert(lastText !== undefined, "Codex request produced no last text delta");
    assert(wordsAtFirstText !== undefined);
    assert(
      assistantText(message) === EXPECTED_RESPONSE,
      'Codex response did not contain exactly 64 space-separated repetitions of "SPEED"',
    );
    assert(
      streamedText === EXPECTED_RESPONSE,
      "Codex stream deltas did not contain the exact fixed response",
    );
    assert(
      message.usage.output >= MIN_OUTPUT_TOKENS,
      `Codex request produced ${message.usage.output} output tokens; expected at least ${MIN_OUTPUT_TOKENS}`,
    );
    assert(
      wordsAtFirstText < EXPECTED_OUTPUT_WORDS,
      "Codex delivered the entire fixed response in its first text delta",
    );
    const textStream = lastText - firstText;
    assert(textStream > 0, "Codex text stream duration must be positive");
    const visibleWordsPerSecond = ((EXPECTED_OUTPUT_WORDS - wordsAtFirstText) * 1000) / textStream;
    assert(
      observed.handshakes.length === 1,
      `Expected one fresh WebSocket, observed ${observed.handshakes.length}`,
    );
    assert(
      observed.responseCreateFrames.length === 2 &&
        observed.responseCreateFrames[0] === "prewarm" &&
        observed.responseCreateFrames[1] === "generation",
      "Expected one prewarm response.create followed by one generation response.create",
    );
    responseCreateFrameCount += observed.responseCreateFrames.length;
    const [handshake] = observed.handshakes;
    assert(handshake !== undefined, "WebSocket handshake was not observed");
    assert(
      handshake.routingHint === expectedHint,
      `Sanitized routing hint mismatch: expected ${expectedHint}, received ${handshake.routingHint ?? "absent"}`,
    );
    assert(
      handshake.timingMetricsRequested === "true",
      "WebSocket timing metrics header was not requested",
    );
    assert(
      handshake.originator === expectedOriginator,
      `Originator mismatch: expected ${expectedOriginator}, received ${handshake.originator ?? "absent"}`,
    );
    const terminalResponses = observed.terminalResponses.toSorted(
      (left, right) => left.messageSequence - right.messageSequence,
    );
    const generationIndex = terminalResponses.findIndex(
      ({ responseId }) => responseId === message.responseId,
    );
    assert(
      terminalResponses.length === 2 && generationIndex === 1,
      "Expected one prewarm terminal followed by the final generation terminal",
    );
    const [prewarmTerminal, generationTerminal] = terminalResponses;
    assert(prewarmTerminal !== undefined && generationTerminal !== undefined);
    for (const [label, terminal] of [
      ["Prewarm", prewarmTerminal],
      ["Generation", generationTerminal],
    ] as const) {
      assert(
        (terminal.type === "response.completed" || terminal.type === "response.done") &&
          (terminal.status === "absent" || terminal.status === "completed"),
        `${label} terminal was not successful: ${terminal.type} status=${terminal.status}`,
      );
    }
    const responseTerminalEvidence: ResponseTerminalEvidence = {
      generation: {
        serviceTier: generationTerminal.serviceTier,
        status: generationTerminal.status,
        type: generationTerminal.type,
      },
      prewarm: {
        serviceTier: prewarmTerminal.serviceTier,
        status: prewarmTerminal.status,
        type: prewarmTerminal.type,
      },
    };
    const tokens = usageTokens(message);
    const costUsd = message.usage.cost.total;
    totalTokens += tokens;
    totalCostUsd += costUsd;
    assert(
      totalTokens <= invocation.maxTotalTokens,
      `Completed usage ${totalTokens} exceeded --max-total-tokens ${invocation.maxTotalTokens}`,
    );
    assert(
      totalCostUsd <= invocation.maxCostUsd,
      `Completed cost $${totalCostUsd.toFixed(6)} exceeded --max-cost-usd $${invocation.maxCostUsd.toFixed(6)}`,
    );
    return {
      clientMs: { firstResponse, firstText, lastText, textStream, total },
      costUsd,
      mode,
      pair,
      rawWebSocketTiming: observed.metrics,
      responseTerminalEvidence,
      tokens: {
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        input: message.usage.input,
        output: message.usage.output,
        total: tokens,
      },
      visibleWordsPerSecond,
      wire: {
        cache: "disabled",
        originator: expectedOriginator,
        requestedServiceTier: fastMode ? "priority" : "absent",
        routingHint: expectedHint,
        timingMetricsRequested: true,
      },
      wordsAtFirstText,
    };
  };

  try {
    for (const [pairIndex, order] of orders.entries()) {
      for (const mode of order) {
        samples.push(await takeSample(pairIndex + 1, mode));
      }
    }
    assert(
      probe.socketCount() === samples.length,
      "Each paid sample must construct one unique physical socket",
    );
  } finally {
    probe.restore();
    observability.close();
  }

  const pairs = Array.from({ length: invocation.pairs }, (_, index) => {
    const off = samples.find((sample) => sample.pair === index + 1 && sample.mode === "off");
    const on = samples.find((sample) => sample.pair === index + 1 && sample.mode === "on");
    assert(off !== undefined && on !== undefined, `Pair ${index + 1} is incomplete`);
    return {
      clientDifferenceMs: {
        firstResponse: off.clientMs.firstResponse - on.clientMs.firstResponse,
        firstText: off.clientMs.firstText - on.clientMs.firstText,
        lastText: off.clientMs.lastText - on.clientMs.lastText,
        textStream: off.clientMs.textStream - on.clientMs.textStream,
        total: off.clientMs.total - on.clientMs.total,
      },
      order: orders[index],
      pair: index + 1,
      throughput: {
        fastVisibleWordsPerSecond: on.visibleWordsPerSecond,
        speedup: on.visibleWordsPerSecond / off.visibleWordsPerSecond,
        standardVisibleWordsPerSecond: off.visibleWordsPerSecond,
      },
    };
  });
  const averageVisibleWordsPerSecond = (mode: Mode) =>
    samples
      .filter((sample) => sample.mode === mode)
      .reduce((total, sample) => total + sample.visibleWordsPerSecond, 0) / invocation.pairs;
  const standardVisibleWordsPerSecond = averageVisibleWordsPerSecond("off");
  const fastVisibleWordsPerSecond = averageVisibleWordsPerSecond("on");
  const throughput = {
    fastVisibleWordsPerSecond,
    speedup: fastVisibleWordsPerSecond / standardVisibleWordsPerSecond,
    standardVisibleWordsPerSecond,
  };
  const artifact = {
    artifact: "clanker.codex-provider/live-fast-v1",
    budgets: {
      maxCostUsd: invocation.maxCostUsd,
      maxPaidGenerationRequests: invocation.pairs * 2,
      maxTotalTokens: invocation.maxTotalTokens,
      timeoutMsPerRequest: invocation.timeoutMs,
    },
    generatedAt: new Date().toISOString(),
    model: `openai-codex/${model.id}`,
    pairs,
    samples,
    summary: {
      costUsd: totalCostUsd,
      pairs: invocation.pairs,
      rawTimingEvents: samples.reduce(
        (total, sample) => total + sample.rawWebSocketTiming.length,
        0,
      ),
      requests: {
        generation: samples.length,
        prewarm: samples.length,
        responseCreateFrames: responseCreateFrameCount,
      },
      throughput,
      totalTokens,
    },
    proofConfiguration: {
      cache: "disabled",
      expectedOutput: {
        repetitions: EXPECTED_OUTPUT_WORDS,
        separator: "single space",
        word: "SPEED",
      },
      minimumOutputTokens: MIN_OUTPUT_TOKENS,
      outputVerification: "exact",
      reasoning: "none",
      transport: "websocket",
    },
    randomizationSeed: invocation.seed,
  };
  await mkdir(path.dirname(invocation.out), { recursive: true });
  await writeFile(invocation.out, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        artifact: invocation.out,
        costUsd: totalCostUsd,
        pairs: invocation.pairs,
        responseTerminalEvidence: samples.map((sample) => ({
          evidence: sample.responseTerminalEvidence,
          mode: sample.mode,
        })),
        seed: invocation.seed,
        throughput,
        totalTokens,
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] === import.meta.filename) {
  try {
    const invocation = parseInvocation(process.argv.slice(2));
    if (invocation === undefined) {
      console.log(help);
    } else {
      await run(invocation);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
