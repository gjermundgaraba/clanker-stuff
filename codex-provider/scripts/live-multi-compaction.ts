#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CompactionEntry,
  CreateAgentSessionOptions,
  CustomEntry,
  ExtensionError,
  ExtensionFactory,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { Checkpoint } from "../checkpoint.ts";
import { CHECKPOINT_CUSTOM_TYPE, parseCheckpoint } from "../checkpoint.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "index.ts");
const CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE = "codex-provider.diagnostic";
const CODEX_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE =
  "codex-provider.transport-fallback";
const TRANSPORT_FALLBACK_WARNING =
  "OpenAI Codex WebSocket is unavailable; using SSE for this session.";
const TRUNCATED_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated";
const TIMESTAMP_CANARY_TYPE = "live-timestamp-canary";
const TIMESTAMP_CANARY_SENTINEL = "MIDTURN-TIMESTAMP-CANARY-7F3A";
const MAGENTA_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAAA1BMVEX/AP804Oa6AAAAD0lEQVQoz2NgGAWjgHwAAAJAAAGMxat3AAAAAElFTkSuQmCC";

type TransportMode = "fallback" | "sse" | "websocket";

const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive safe integer`
  );
  return value;
};

const customEntries = (
  manager: SessionManager,
  customType: string
): CustomEntry[] =>
  manager
    .getBranch()
    .filter(
      (entry): entry is CustomEntry =>
        entry.type === "custom" && entry.customType === customType
    );

const compactionEntries = (manager: SessionManager): CompactionEntry[] =>
  manager
    .getBranch()
    .filter((entry): entry is CompactionEntry => entry.type === "compaction");

const parseLiveCheckpoint = (value: unknown, label: string): Checkpoint => {
  const parsed = parseCheckpoint(value);
  if (!parsed.ok) {
    throw new Error(`${label}: ${parsed.error}`);
  }
  return parsed.checkpoint;
};

const lifecycleCheckpoint = (
  entry: CompactionEntry | undefined
): Checkpoint => {
  assert(entry !== undefined, "Lifecycle compaction entry missing");
  assert(
    isRecord(entry.details) && entry.details.type === CHECKPOINT_CUSTOM_TYPE,
    "Lifecycle compaction details missing"
  );
  return parseLiveCheckpoint(
    entry.details.checkpoint,
    "Lifecycle checkpoint invalid"
  );
};

const contextTokens = (usage: Usage | undefined): number => {
  if (usage === undefined) {
    return 0;
  }
  return usage.totalTokens === 0
    ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    : usage.totalTokens;
};

const parsedCheckpoint = (entry: CustomEntry | undefined): Checkpoint => {
  assert(entry !== undefined, "Checkpoint missing");
  return parseLiveCheckpoint(entry.data, "Checkpoint invalid");
};

const responseId = (entry: CustomEntry | undefined): string =>
  parsedCheckpoint(entry).response.id;

const assertCheckpoint = (
  entry: CustomEntry | undefined,
  expectedRound: number,
  forcedContextWindow: number,
  minimumSideInputTokens: number,
  requireLocalThreshold: boolean,
  expectedPhase: "mid-turn" | "pre-sampling" = "pre-sampling"
): {
  readonly runtime: Checkpoint["runtime"];
  readonly sideInputTokens: number;
} => {
  const checkpoint = parsedCheckpoint(entry);
  assert(
    checkpoint.phase === expectedPhase && checkpoint.reason === "threshold",
    `Round ${expectedRound}: unexpected checkpoint phase/reason`
  );
  if (requireLocalThreshold) {
    assert(
      checkpoint.sourceTokens >= Math.floor(forcedContextWindow * 0.9),
      `Round ${expectedRound}: checkpoint source did not cross 90%`
    );
  }
  const { usage } = checkpoint.response;
  const sideInputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  assert(
    sideInputTokens >= minimumSideInputTokens,
    `Round ${expectedRound}: provider processed ${sideInputTokens} input tokens; expected at least ${minimumSideInputTokens}`
  );
  assert(
    checkpoint.runtime.windowNumber === expectedRound,
    `Round ${expectedRound}: expected window ${expectedRound}, received ${checkpoint.runtime.windowNumber}`
  );
  assert(
    checkpoint.runtime.currentWindowId !== checkpoint.runtime.previousWindowId,
    `Round ${expectedRound}: current and previous window IDs match`
  );
  return { runtime: checkpoint.runtime, sideInputTokens };
};

const lastAssistant = (session: AgentSession): AssistantMessage | undefined =>
  session.messages
    .toReversed()
    .find(
      (message): message is AssistantMessage => message.role === "assistant"
    );

const assistantText = (message: AssistantMessage | undefined) =>
  message?.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("") ?? "";

const assertTransportFallbackDiagnostic = (
  message: AssistantMessage | undefined,
  label: string
) => {
  assert(
    message?.stopReason === "stop",
    `${label}: assistant did not complete`
  );
  const diagnostics = message.diagnostics ?? [];
  assert(
    diagnostics.length === 1,
    `${label}: expected exactly one transport fallback diagnostic`
  );
  const [diagnostic] = diagnostics;
  assert(
    diagnostic?.type === CODEX_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE &&
      Number.isSafeInteger(diagnostic.timestamp) &&
      diagnostic.timestamp > 0 &&
      diagnostic.error === undefined &&
      !("raw" in diagnostic) &&
      isRecord(diagnostic.details),
    `${label}: transport fallback diagnostic is invalid`
  );
  assert(
    JSON.stringify(Object.keys(diagnostic).toSorted()) ===
      JSON.stringify(["details", "timestamp", "type"]) &&
      JSON.stringify(Object.keys(diagnostic.details).toSorted()) ===
        JSON.stringify(["configuredTransport"]) &&
      (diagnostic.details.configuredTransport === "auto" ||
        diagnostic.details.configuredTransport === "websocket" ||
        diagnostic.details.configuredTransport === "websocket-cached"),
    `${label}: transport fallback diagnostic contains unapproved fields or values`
  );
};

const rewrittenTrailingOutputCount = (requestBodyValue: unknown): number => {
  assert(isRecord(requestBodyValue), "Compaction request body is invalid");
  assert(Array.isArray(requestBodyValue.input), "Compaction input is missing");
  return requestBodyValue.input.filter((item) => {
    if (!isRecord(item)) {
      return false;
    }
    if (
      item.type !== "function_call_output" &&
      item.type !== "custom_tool_call_output"
    ) {
      return (
        item.type === "tool_search_output" &&
        Array.isArray(item.tools) &&
        item.tools.length === 0
      );
    }
    return isRecord(item.output)
      ? item.output.body === TRUNCATED_OUTPUT_MESSAGE
      : item.output === TRUNCATED_OUTPUT_MESSAGE;
  }).length;
};

const disposedSessions = new WeakSet<AgentSession>();

const disposeCanarySession = async (
  session: AgentSession,
  transportMode: TransportMode
) => {
  if (disposedSessions.has(session)) {
    return;
  }
  disposedSessions.add(session);
  try {
    if (transportMode === "websocket") {
      await session.reload();
    }
  } finally {
    session.dispose();
  }
};

const syntheticHex = (bytes: number): string =>
  randomBytes(Math.ceil(bytes / 2))
    .toString("hex")
    .slice(0, bytes);

const syntheticText = (bytes: number): string => {
  const unit = "The quick brown fox jumps over the lazy dog. ";
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
};

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  assert(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
};

const parseTransport = (value: string): TransportMode => {
  assert(
    value === "fallback" || value === "sse" || value === "websocket",
    `Unknown transport mode: ${value}`
  );
  return value;
};

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const requestBody = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): Promise<string | undefined> => {
  const value =
    init?.body ??
    (input instanceof Request
      ? Buffer.from(await input.clone().arrayBuffer())
      : undefined);
  if (typeof value === "string") {
    return value;
  }
  let bytes: Buffer | undefined;
  if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (bytes === undefined) {
    return undefined;
  }
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  return (
    headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes)
      : bytes
  ).toString("utf-8");
};

const compactionRequestBody = (
  body: string | undefined
): Record<string, unknown> | undefined => {
  if (body === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || !Array.isArray(value.input)) {
      return undefined;
    }
    const trigger: unknown = value.input.at(-1);
    return isRecord(trigger) && trigger.type === "compaction_trigger"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

export const installTransportProbe = (
  mode: TransportMode,
  forceSse = false,
  injectStreamFault = false
) => {
  const failureObservations: Promise<void>[] = [];
  const failures: string[] = [];
  const responses: string[] = [];
  const requests: { readonly body?: string; readonly pathname: string }[] = [];
  const observeFailures = async (response: Response) => {
    const body = await response.clone().text();
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(line.slice(6));
        if (!isRecord(value) || typeof value.type !== "string") {
          continue;
        }
        const responseValue = isRecord(value.response)
          ? value.response
          : undefined;
        if (value.type !== "response.failed") {
          continue;
        }
        const errorValue = isRecord(responseValue?.error)
          ? responseValue.error
          : undefined;
        failures.push(
          typeof errorValue?.code === "string"
            ? errorValue.code
            : "response.failed"
        );
      } catch {
        // The provider owns strict response parsing.
      }
    }
  };
  let sseRequests = 0;
  let streamFaults = 0;
  let websocketConstructions = 0;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const { pathname } = new URL(requestUrl(input));
    const observed =
      pathname.endsWith("/responses") ||
      pathname.endsWith("/responses/compact");
    const body = await requestBody(input, init);
    const compactionRequest = compactionRequestBody(body) !== undefined;
    let response = await nativeFetch(input, init);
    if (observed) {
      sseRequests += 1;
      requests.push({ body, pathname });
      responses.push(`${pathname}:${response.status}`);
      if (
        injectStreamFault &&
        streamFaults === 0 &&
        compactionRequest &&
        response.body !== null
      ) {
        streamFaults += 1;
        const reader = response.body.getReader();
        const faultBody = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const first: unknown = await reader.read();
            assert(isRecord(first), "Response read result is invalid");
            if (first.done !== true) {
              const { value } = first;
              assert(
                value instanceof Uint8Array,
                "Response chunk is not bytes"
              );
              controller.enqueue(value.subarray(0, 1));
            }
            await reader.cancel();
            controller.error(new Error("Injected client-side stream fault"));
          },
        });
        response = new Response(faultBody, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      } else {
        failureObservations.push(observeFailures(response));
      }
    }
    return response;
  };

  if (mode === "fallback") {
    const FailingWebSocket = function FailingWebSocket() {
      websocketConstructions += 1;
      throw new Error("Injected WebSocket connection failure");
    };
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FailingWebSocket,
      writable: true,
    });
  } else if (forceSse) {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: undefined,
      writable: true,
    });
  } else if (typeof globalThis.WebSocket === "function") {
    const NativeWebSocket = globalThis.WebSocket;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: new Proxy(NativeWebSocket, {
        construct(target, argumentsList) {
          websocketConstructions += 1;
          // oxlint-disable-next-line typescript/no-unsafe-return -- transparent constructor probe preserves the native WebSocket instance
          return Reflect.construct(target, argumentsList, target);
        },
      }),
      writable: true,
    });
  } else {
    assert(mode === "sse", "Native WebSocket support is unavailable");
  }

  return {
    async failures() {
      await Promise.allSettled(failureObservations);
      return failures;
    },
    get requests() {
      return requests;
    },
    get responses() {
      return responses;
    },
    get sseRequests() {
      return sseRequests;
    },
    get streamFaults() {
      return streamFaults;
    },
    get websocketConstructions() {
      return websocketConstructions;
    },
  };
};

const assertTransport = (
  mode: TransportMode,
  probe: ReturnType<typeof installTransportProbe>,
  expectedFallbackConstructions = 1
) => {
  if (mode === "websocket") {
    assert(
      probe.websocketConstructions > 0 && probe.sseRequests === 0,
      `WebSocket canary used ${probe.sseRequests} SSE request(s) across ${probe.websocketConstructions} WebSocket connection(s)`
    );
  } else if (mode === "fallback") {
    assert(
      probe.websocketConstructions === expectedFallbackConstructions,
      `Fallback canary used ${probe.websocketConstructions} WebSocket attempt(s) and ${probe.sseRequests} SSE request(s)`
    );
  } else {
    assert(
      probe.websocketConstructions === 0,
      `SSE canary used ${probe.websocketConstructions} WebSocket connection(s) and ${probe.sseRequests} SSE request(s)`
    );
  }
};

// oxlint-disable-next-line complexity -- branch and restart assertions share one child setup
const runFreshChild = async (branchMode: boolean) => {
  const prefix = branchMode
    ? "CODEX_COMPACTION_BRANCH"
    : "CODEX_COMPACTION_RESTART";
  const environment = (name: string) =>
    requiredEnvironment(`${prefix}_${name}`);
  const canaryCwd = environment("CWD");
  const isolatedAgentDir = environment("AGENT_DIR");
  const modelId = environment("MODEL");
  const resultFile = environment("RESULT");
  const sessionDir = environment("SESSION_DIR");
  const sessionFile = environment("SESSION_FILE");
  const transportMode = parseTransport(environment("TRANSPORT"));
  const transportProbe = installTransportProbe(transportMode);
  const realAgentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(realAgentDir, "auth.json"),
    modelsPath: path.join(realAgentDir, "models.json"),
  });
  const baseModel = modelRuntime.getModel("openai-codex", modelId);
  assert(
    baseModel !== undefined,
    `Model openai-codex/${modelId} is unavailable`
  );
  const extensionErrors: ExtensionError[] = [];
  const notifications: string[] = [];
  const openSession = async (
    manager: SessionManager,
    contextWindow: number
  ): Promise<AgentSession> => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      transport: transportMode === "sse" ? "sse" : "websocket",
    });
    const resourceLoader = new DefaultResourceLoader({
      additionalExtensionPaths: [EXTENSION_PATH],
      agentDir: isolatedAgentDir,
      cwd: canaryCwd,
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      systemPrompt: `This is a fresh-process ${branchMode ? "branch" : "restart"} canary. Reply with one short acknowledgement and do not use tools.`,
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      agentDir: isolatedAgentDir,
      cwd: canaryCwd,
      model: { ...baseModel, contextWindow },
      modelRuntime,
      noTools: "all",
      resourceLoader,
      sessionManager: manager,
      settingsManager,
      thinkingLevel: "minimal",
    });
    await created.session.bindExtensions({
      onError: (error) => {
        extensionErrors.push(error);
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- canary stubs only UI methods used by this extension
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });
    if (created.session.model?.contextWindow !== contextWindow) {
      await created.session.setModel({ ...baseModel, contextWindow });
    }
    assert(
      created.session.model?.contextWindow === contextWindow,
      `Fresh-process model window is ${created.session.model?.contextWindow ?? "missing"}; expected ${contextWindow}`
    );
    return created.session;
  };

  let manager = SessionManager.open(sessionFile, sessionDir, canaryCwd);
  let session = await openSession(
    manager,
    branchMode ? 4096 : Math.max(baseModel.contextWindow, 1_000_000)
  );
  try {
    if (!branchMode) {
      const expectedResponseId = environment("RESPONSE");
      const expectedRounds = Number(environment("ROUNDS"));
      assert(
        Number.isSafeInteger(expectedRounds) && expectedRounds >= 1,
        "Fresh-process checkpoint count is invalid"
      );
      await session.prompt("FRESH PROCESS RESUME ONE. Reply only RESUMED ONE.");
      const firstAssistant = lastAssistant(session);
      const fallbackAfterFirst = transportProbe.websocketConstructions;
      await session.prompt("FRESH PROCESS RESUME TWO. Reply only RESUMED TWO.");
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      assert(
        checkpoints.length === expectedRounds &&
          responseId(checkpoints.at(-1)) === expectedResponseId,
        "Fresh-process restart unexpectedly created, lost, or replaced a checkpoint"
      );
      parsedCheckpoint(checkpoints.at(-1));
      assert(
        lastAssistant(session)?.stopReason === "stop",
        "Fresh-process restart assistant did not complete"
      );
      assert(
        customEntries(manager, CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE).length === 0,
        "Fresh-process restart persisted a framing diagnostic"
      );
      assert(extensionErrors.length === 0, "Extension errors were emitted");
      if (transportMode === "fallback") {
        assertTransportFallbackDiagnostic(
          firstAssistant,
          "Fresh-process fallback"
        );
        assert(
          notifications.filter(
            (notification) => notification === TRANSPORT_FALLBACK_WARNING
          ).length === 1,
          "Fresh-process fallback warning was not emitted exactly once"
        );
        assert(
          (lastAssistant(session)?.diagnostics ?? []).length === 0,
          "Fresh-process sticky SSE assistant emitted another diagnostic"
        );
        assert(
          fallbackAfterFirst === 1 &&
            transportProbe.websocketConstructions === fallbackAfterFirst,
          `Fresh-process fallback made ${fallbackAfterFirst} WebSocket attempt(s) on the first turn and ${transportProbe.websocketConstructions} total`
        );
      }
      assertTransport(transportMode, transportProbe, 1);
      await writeFile(
        resultFile,
        JSON.stringify({
          responseId: expectedResponseId,
          sseRequests: transportProbe.sseRequests,
          status: "passed",
          transport: transportMode,
          websocketConstructions: transportProbe.websocketConstructions,
        })
      );
      return;
    }

    const firstEntryId = environment("FIRST_ENTRY");
    const firstResponseId = environment("FIRST_RESPONSE");
    const secondEntryId = environment("SECOND_ENTRY");
    const secondResponseId = environment("SECOND_RESPONSE");
    await session.navigateTree(firstEntryId, { summarize: false });
    const activeCheckpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    const [activeCheckpoint] = activeCheckpoints;
    assert(
      activeCheckpoints.length === 1 &&
        responseId(activeCheckpoint) === firstResponseId,
      "Checkpoint 1 was not active after the fresh-process fork"
    );
    const firstWindow = parsedCheckpoint(activeCheckpoint).runtime;
    await session.prompt(
      `FRESH PROCESS DIVERGENT BRANCH.\n${"d".repeat(20_000)}`
    );
    const divergentCheckpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    assert(
      divergentCheckpoints.length === 2 &&
        responseId(divergentCheckpoints[0]) === firstResponseId &&
        responseId(divergentCheckpoints[1]) !== secondResponseId,
      "Divergent branch reused or retained checkpoint 2"
    );
    const [, divergentEntry] = divergentCheckpoints;
    assert(divergentEntry !== undefined, "Divergent checkpoint missing");
    const divergentEntryId = divergentEntry.id;
    const divergentResponseId = responseId(divergentEntry);
    const divergentWindow = parsedCheckpoint(divergentEntry).runtime;
    assert(
      divergentWindow.windowNumber > firstWindow.windowNumber &&
        divergentWindow.previousWindowId === firstWindow.currentWindowId &&
        divergentWindow.currentWindowId !== firstWindow.currentWindowId,
      "Divergent checkpoint window did not advance from checkpoint 1"
    );
    assert(
      lastAssistant(session)?.stopReason === "stop",
      "Divergent branch assistant did not complete"
    );
    assertTransport(transportMode, transportProbe);
    await disposeCanarySession(session, transportMode);

    manager = SessionManager.open(sessionFile, sessionDir, canaryCwd);
    session = await openSession(
      manager,
      Math.max(baseModel.contextWindow, 1_000_000)
    );
    await session.navigateTree(secondEntryId, { summarize: false });
    await session.prompt("FRESH PROCESS ORIGINAL BRANCH. Reply only ORIGINAL.");
    const originalCheckpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    assert(
      originalCheckpoints.length === 2 &&
        responseId(originalCheckpoints[0]) === firstResponseId &&
        responseId(originalCheckpoints[1]) === secondResponseId,
      "Original branch did not retain checkpoint 2"
    );
    assert(
      !originalCheckpoints.some(
        (entry) => responseId(entry) === divergentResponseId
      ),
      "Divergent checkpoint leaked into the original branch"
    );
    assert(
      lastAssistant(session)?.stopReason === "stop",
      "Original branch assistant did not complete"
    );
    assertTransport(
      transportMode,
      transportProbe,
      transportMode === "fallback" ? 2 : 1
    );
    await session.navigateTree(divergentEntryId, { summarize: false });
    const restoredDivergent = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    assert(
      restoredDivergent.length === 2 &&
        responseId(restoredDivergent[1]) === divergentResponseId &&
        !restoredDivergent.some(
          (entry) => responseId(entry) === secondResponseId
        ),
      "Divergent branch was not independently restorable"
    );
    assert(
      customEntries(manager, CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE).length === 0,
      "Branch replay persisted a framing diagnostic"
    );
    assert(extensionErrors.length === 0, "Extension errors were emitted");

    await writeFile(
      resultFile,
      JSON.stringify({
        divergentResponseId,
        firstResponseId,
        originalResponseId: secondResponseId,
        sseRequests: transportProbe.sseRequests,
        status: "passed",
        transport: transportMode,
        websocketConstructions: transportProbe.websocketConstructions,
      })
    );
  } finally {
    await disposeCanarySession(session, transportMode);
  }
};

// oxlint-disable-next-line complexity -- one linear live-canary workflow
const main = async () => {
  const branchMode = process.argv.includes("--branch");
  const capabilityMode = process.argv.includes("--capabilities");
  const fallbackMode = process.argv.includes("--fallback");
  const midTurn = process.argv.includes("--mid-turn");
  const realWindowMode = process.argv.includes("--real-window");
  const portableMode = process.argv.includes("--portable");
  const realWindow = midTurn || realWindowMode;
  const soakMode = process.argv.includes("--soak");
  const sseMode = process.argv.includes("--sse");
  const streamFaultMode = process.argv.includes("--stream-fault");
  const thresholdMode = process.argv.includes("--threshold");
  const websocketMode = process.argv.includes("--websocket");
  assert(
    [fallbackMode, sseMode, websocketMode].filter(Boolean).length <= 1,
    "Choose only one transport: --sse, --websocket, or --fallback"
  );
  assert(
    [
      branchMode,
      capabilityMode,
      portableMode,
      realWindow,
      soakMode,
      streamFaultMode,
      thresholdMode,
    ].filter(Boolean).length <= 1,
    "Choose only one behavior mode: --branch, --capabilities, --portable, --real-window, --mid-turn, --soak, --stream-fault, or --threshold"
  );
  let transportMode: TransportMode = "sse";
  if (fallbackMode) {
    transportMode = "fallback";
  } else if (websocketMode) {
    transportMode = "websocket";
  }
  assert(
    !portableMode || transportMode === "sse",
    "Portable canary requires SSE request inspection"
  );
  assert(
    !realWindow || transportMode !== "websocket",
    "Real-window and mid-turn canaries require SSE request inspection"
  );
  assert(
    !streamFaultMode || transportMode === "sse",
    "Stream-fault canary requires SSE"
  );
  if (process.argv.includes("--help")) {
    console.log(`Usage:
  node codex-provider/scripts/live-multi-compaction.ts [--sse|--websocket|--fallback] [--branch|--capabilities|--portable|--real-window|--mid-turn|--soak|--stream-fault|--threshold]

Environment:
  CODEX_COMPACTION_LIVE_MODEL          Model ID (default: gpt-5.6-sol)
  CODEX_COMPACTION_LIVE_ALT_MODEL      Capability-canary switch target (default: gpt-5.6-terra)
  CODEX_COMPACTION_LIVE_ROUNDS         Inline compactions (default: 3; soak: 10; real/branch/mid-turn/stream-fault: 2)
  CODEX_COMPACTION_LIVE_CONTEXT_WINDOW Forced estimator window (default: 4096)
  CODEX_COMPACTION_LIVE_PAYLOAD_BYTES  Synthetic bytes per round (default: 20000)
  CODEX_COMPACTION_LIVE_DIR            Parent directory for retained artifacts`);
    return;
  }
  const configuredModel = process.env.CODEX_COMPACTION_LIVE_MODEL?.trim();
  const modelId =
    configuredModel !== undefined && configuredModel.length > 0
      ? configuredModel
      : "gpt-5.6-sol";
  let defaultRounds = 3;
  if (soakMode) {
    defaultRounds = 10;
  } else if (branchMode || realWindow || streamFaultMode) {
    defaultRounds = 2;
  }
  const rounds = positiveInteger("CODEX_COMPACTION_LIVE_ROUNDS", defaultRounds);
  if (!(capabilityMode || portableMode || thresholdMode)) {
    assert(rounds >= 2, "Live canary requires at least 2 compactions");
  }

  execFileSync(
    process.execPath,
    [path.join(PACKAGE_ROOT, "audit-local-order.ts"), process.cwd()],
    { stdio: "inherit" }
  );

  const artifactParent = path.resolve(
    process.env.CODEX_COMPACTION_LIVE_DIR ?? os.tmpdir()
  );
  await mkdir(artifactParent, { recursive: true });
  const runRoot = await mkdtemp(
    path.join(artifactParent, "codex-provider-live-")
  );
  const canaryCwd = path.join(runRoot, "workspace");
  const isolatedAgentDir = path.join(runRoot, "agent");
  const sessionDir = path.join(runRoot, "sessions");
  await Promise.all([
    mkdir(canaryCwd, { recursive: true }),
    mkdir(isolatedAgentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);

  const realAgentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(realAgentDir, "auth.json"),
    modelsPath: path.join(realAgentDir, "models.json"),
  });
  const baseModel = modelRuntime.getModel("openai-codex", modelId);
  assert(
    baseModel !== undefined,
    `Model openai-codex/${modelId} is unavailable`
  );
  assert(
    baseModel.api === "openai-codex-responses",
    `Model ${modelId} does not use openai-codex-responses`
  );
  const auth = await modelRuntime.getAuth(baseModel);
  assert(auth !== undefined, "OpenAI Codex auth is unavailable");
  const alternateValue = process.env.CODEX_COMPACTION_LIVE_ALT_MODEL?.trim();
  const configuredAlternate =
    alternateValue !== undefined && alternateValue.length > 0
      ? alternateValue
      : undefined;
  const availableModels = capabilityMode
    ? await modelRuntime.getAvailable()
    : [];
  const alternateCandidates = capabilityMode
    ? availableModels.filter(
        (candidate) =>
          candidate.provider === "openai-codex" &&
          candidate.api === "openai-codex-responses" &&
          candidate.id !== modelId
      )
    : [];
  const alternateModel = capabilityMode
    ? (alternateCandidates.find(
        ({ id }) => id === (configuredAlternate ?? "gpt-5.6-terra")
      ) ??
      (configuredAlternate === undefined ? alternateCandidates[0] : undefined))
    : undefined;
  if (capabilityMode) {
    assert(
      baseModel.input.includes("image"),
      `Capability model ${modelId} does not accept images`
    );
    assert(
      alternateModel !== undefined,
      configuredAlternate === undefined
        ? "No alternate OpenAI Codex model is available"
        : `Alternate model openai-codex/${configuredAlternate} is unavailable`
    );
  }
  const forcedContextWindow =
    realWindow || thresholdMode
      ? baseModel.contextWindow
      : positiveInteger("CODEX_COMPACTION_LIVE_CONTEXT_WINDOW", 4096);
  let payloadBytes =
    realWindow || thresholdMode
      ? 0
      : positiveInteger("CODEX_COMPACTION_LIVE_PAYLOAD_BYTES", 20_000);
  if (!(realWindow || portableMode || thresholdMode)) {
    assert(
      payloadBytes >= forcedContextWindow * 0.9 * 4,
      "Synthetic payload must cross the 90% local context estimate"
    );
  }
  const minimumSideInputTokens = realWindow
    ? Math.floor(forcedContextWindow * (midTurn ? 0.8 : 0.9))
    : 0;

  const extensionErrors: ExtensionError[] = [];
  const notifications: string[] = [];
  const timestampCanaryState: {
    contextSeen?: boolean;
    liveTimestamp?: number;
    persistedTimestamp?: number;
    providerSeen?: boolean;
  } = {};
  const timestampCanaryExtension: ExtensionFactory = (pi) => {
    let injected = false;
    pi.on("before_agent_start", (event) => {
      const shouldInject =
        !injected && event.prompt.includes("mid-turn canary round 2");
      if (shouldInject) {
        injected = true;
      }
      return shouldInject
        ? {
            message: {
              content: TIMESTAMP_CANARY_SENTINEL,
              customType: TIMESTAMP_CANARY_TYPE,
              display: false,
            },
          }
        : undefined;
    });
    pi.on("message_end", (event) => {
      if (
        event.message.role === "custom" &&
        event.message.customType === TIMESTAMP_CANARY_TYPE
      ) {
        event.message.timestamp = 1;
      }
    });
    pi.on("context", (event, ctx) => {
      const live = event.messages.find(
        (message) =>
          message.role === "custom" &&
          message.customType === TIMESTAMP_CANARY_TYPE
      );
      if (live === undefined) {
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const persisted = branch.find(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === TIMESTAMP_CANARY_TYPE
      );
      assert(
        persisted !== undefined &&
          live.timestamp !== new Date(persisted.timestamp).getTime() &&
          branch.some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === CHECKPOINT_CUSTOM_TYPE
          ),
        "Timestamp canary did not precede active checkpoint replay"
      );
      timestampCanaryState.contextSeen = true;
      timestampCanaryState.liveTimestamp = live.timestamp;
      timestampCanaryState.persistedTimestamp = new Date(
        persisted.timestamp
      ).getTime();
    });
    pi.on("before_provider_request", (event) => {
      const payload = JSON.stringify(event.payload);
      if (!payload.includes(TIMESTAMP_CANARY_SENTINEL)) {
        return;
      }
      assert(
        payload.split(TIMESTAMP_CANARY_SENTINEL).length === 2 &&
          payload.split('"type":"compaction"').length === 2,
        "Timestamp canary duplicated sentinel or opaque state"
      );
      timestampCanaryState.providerSeen = true;
    });
  };
  const createCanarySession = async (
    sessionManager: SessionManager,
    contextWindow: number,
    loadCompaction = true,
    customTools: ToolDefinition[] = [],
    systemPrompt?: string,
    manualCompaction = false
  ): Promise<AgentSession> => {
    const settingsManager = SettingsManager.inMemory({
      compaction: manualCompaction
        ? { enabled: false, keepRecentTokens: 64, reserveTokens: 1024 }
        : { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      transport: transportMode === "sse" ? "sse" : "websocket",
    });
    const resourceLoader = new DefaultResourceLoader({
      additionalExtensionPaths: loadCompaction ? [EXTENSION_PATH] : [],
      agentDir: isolatedAgentDir,
      cwd: canaryCwd,
      extensionFactories:
        loadCompaction && midTurn ? [timestampCanaryExtension] : [],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      systemPrompt:
        systemPrompt ??
        (customTools.length > 0
          ? "For every user request, call context_filler exactly once, then reply only MIDTURN COMPLETE. Never call the tool more than once for one request."
          : "This is a live compaction canary. Reply with one short acknowledgement and do not use tools."),
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    assert(
      loaded.errors.length === 0,
      `Extension loading failed: ${loaded.errors.map(({ error }) => error).join("; ")}`
    );
    if (loadCompaction) {
      assert(
        loaded.extensions.some(
          (extension) => path.resolve(extension.resolvedPath) === EXTENSION_PATH
        ),
        "codex-provider extension was not loaded"
      );
    }
    const toolOptions: Pick<
      CreateAgentSessionOptions,
      "customTools" | "noTools" | "tools"
    > =
      customTools.length > 0
        ? {
            customTools,
            tools: customTools.map((tool) => tool.name),
          }
        : { noTools: "all" };
    const created = await createAgentSession({
      agentDir: isolatedAgentDir,
      cwd: canaryCwd,
      ...toolOptions,
      model: { ...baseModel, contextWindow },
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: "minimal",
    });
    await created.session.bindExtensions({
      onError: (error) => {
        extensionErrors.push(error);
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- canary stubs only UI methods used by this extension
      uiContext: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => null,
      } as unknown as ExtensionUIContext,
    });
    if (created.session.model?.contextWindow !== contextWindow) {
      await created.session.setModel({ ...baseModel, contextWindow });
    }
    assert(
      created.session.model?.contextWindow === contextWindow,
      `Canary model window is ${created.session.model?.contextWindow ?? "missing"}; expected ${contextWindow}`
    );
    return created.session;
  };

  let calibration:
    | { bytesPerToken: number; inputTokens: number; probeBytes: number }
    | undefined;
  if (realWindow) {
    const probeBytes = 64_000;
    const syntheticPayload = midTurn ? syntheticText : syntheticHex;
    const probeManager = SessionManager.inMemory(canaryCwd);
    const probe = await createCanarySession(
      probeManager,
      forcedContextWindow,
      false
    );
    try {
      await probe.prompt(
        `TOKEN DENSITY CALIBRATION. Reply only CALIBRATED.\n${syntheticPayload(probeBytes)}`
      );
      const probeResult = lastAssistant(probe);
      const probeTokens = contextTokens(probeResult?.usage);
      assert(
        probeResult?.stopReason === "stop" &&
          Number.isSafeInteger(probeTokens) &&
          probeTokens > 0,
        "Token-density calibration request failed"
      );
      calibration = {
        bytesPerToken: probeBytes / probeTokens,
        inputTokens: probeTokens,
        probeBytes,
      };
    } finally {
      probe.dispose();
    }
    payloadBytes = positiveInteger(
      "CODEX_COMPACTION_LIVE_PAYLOAD_BYTES",
      midTurn
        ? Math.max(
            Math.ceil(forcedContextWindow * 0.9 * 4 * 1.005),
            Math.ceil(minimumSideInputTokens * 1.02 * calibration.bytesPerToken)
          )
        : Math.ceil(minimumSideInputTokens * 1.015 * calibration.bytesPerToken)
    );
    if (midTurn) {
      assert(
        Math.ceil(payloadBytes / 4) >= Math.floor(forcedContextWindow * 0.9),
        "Mid-turn tool output does not cross the local compaction threshold"
      );
    } else {
      assert(
        Math.ceil(payloadBytes / 4) < minimumSideInputTokens,
        "Calibrated payload would trigger the local estimator before server usage"
      );
    }
    console.log(
      `Calibration: ${calibration.inputTokens.toLocaleString()} tokens / ${probeBytes.toLocaleString()} bytes; ${calibration.bytesPerToken.toFixed(3)} bytes/token`
    );
  }

  const transportProbe = installTransportProbe(
    transportMode,
    portableMode,
    streamFaultMode
  );
  const manager = SessionManager.create(canaryCwd, sessionDir);
  let toolCalls = 0;
  const postCompactionToolCalls: number[] = [];
  const structuredCalls: Record<string, unknown>[] = [];
  const midTurnTool: ToolDefinition = {
    description:
      "Return the synthetic context payload. Call exactly once when instructed.",
    execute: async () => {
      toolCalls += 1;
      return {
        content: [
          {
            text: syntheticText(payloadBytes),
            type: "text",
          },
        ],
        details: {},
      };
    },
    label: "Context filler",
    name: "context_filler",
    parameters: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
  };
  const postCompactionTool: ToolDefinition = {
    description:
      "Confirm tool availability after context_filler has caused compaction.",
    execute: async () => {
      postCompactionToolCalls.push(
        customEntries(manager, CHECKPOINT_CUSTOM_TYPE).length
      );
      return {
        content: [
          { text: "post-compaction tool probe complete", type: "text" },
        ],
        details: {},
      };
    },
    label: "Post-compaction probe",
    name: "post_compaction_probe",
    parameters: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
  };
  const thresholdTool: ToolDefinition = {
    description: "Return one short below-threshold probe result.",
    execute: async () => {
      toolCalls += 1;
      return {
        content: [{ text: "threshold probe complete", type: "text" }],
        details: {},
      };
    },
    label: "Threshold probe",
    name: "threshold_probe",
    parameters: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
  };
  const structuredTool: ToolDefinition = {
    constrainedSampling: { strict: "require", type: "json_schema" },
    description:
      "Record the exact structured capability-canary payload requested by the user.",
    execute: async (_toolCallId, params) => {
      if (!isRecord(params)) {
        throw new Error("Structured canary arguments are not an object");
      }
      structuredCalls.push({
        label: params.label,
        ok: params.ok,
        sequence: params.sequence,
      });
      return {
        content: [{ text: "Structured payload recorded.", type: "text" }],
        details: {},
      };
    },
    label: "Capability record",
    name: "capability_record",
    parameters: {
      additionalProperties: false,
      properties: {
        label: { enum: ["structured-canary"], type: "string" },
        ok: { enum: [true], type: "boolean" },
        sequence: { maximum: 42, minimum: 42, type: "integer" },
      },
      required: ["label", "ok", "sequence"],
      type: "object",
    },
  };
  let customTools: ToolDefinition[] = [];
  if (capabilityMode) {
    customTools = [structuredTool];
  } else if (midTurn) {
    customTools = [midTurnTool, postCompactionTool];
  } else if (thresholdMode) {
    customTools = [thresholdTool];
  }
  let systemPrompt: string | undefined;
  if (capabilityMode) {
    systemPrompt =
      "This is a backend capability canary. Follow each user request exactly. Use capability_record only when explicitly requested.";
  } else if (thresholdMode) {
    systemPrompt =
      "This is a below-threshold metadata canary. Call threshold_probe exactly once when requested, then reply only THRESHOLD OK.";
  } else if (portableMode) {
    systemPrompt =
      "This is a portable compaction canary. Follow exact reply formats and preserve memorized values exactly.";
  } else if (midTurn) {
    systemPrompt =
      "For every user request, first call context_filler exactly once. Only after that tool completes, call post_compaction_probe exactly once, then reply only MIDTURN COMPLETE. Never call either tool more than once for one request.";
  }
  const session = await createCanarySession(
    manager,
    forcedContextWindow,
    true,
    customTools,
    systemPrompt,
    portableMode
  );
  if (thresholdMode) {
    const provider = modelRuntime.getProvider("openai-codex");
    assert(
      provider?.refreshModels !== undefined,
      "Threshold canary provider cannot refresh models"
    );
    const { apiKey } = auth.auth;
    assert(apiKey !== undefined, "Threshold canary auth is unavailable");
    type StoreEntry = Awaited<
      ReturnType<
        Parameters<
          NonNullable<typeof provider.refreshModels>
        >[0]["store"]["read"]
      >
    >;
    let stored: StoreEntry;
    await provider.refreshModels({
      allowNetwork: true,
      credential: { env: auth.env, key: apiKey, type: "api_key" },
      force: true,
      store: {
        delete: async () => {
          stored = undefined;
        },
        read: async () => stored,
        write: async (value) => {
          stored = value;
        },
      },
    });
  }
  const ids: string[] = [];
  const sideInputTokens: number[] = [];
  const windows: Checkpoint["runtime"][] = [];
  const estimatorEvidence: {
    readonly declaredContextWindow: number;
    readonly effectiveContextLimit: number;
    readonly localEstimatedSourceTokens: number;
    readonly localToProviderRatio: number;
    readonly model: string;
    readonly providerPromptTokens: number;
    readonly responsesLite: boolean;
    readonly rewrittenTrailingOutputs: number;
    readonly round: number;
  }[] = [];
  try {
    console.log(`Live artifacts: ${runRoot}`);
    if (portableMode) {
      await session.prompt(
        "Create a unique recall token in the exact format OPAQUE- followed by 12 uppercase hexadecimal characters. Reply only with that token."
      );
      const secret = assistantText(lastAssistant(session)).trim();
      assert(
        /^OPAQUE-[0-9A-F]{12}$/u.test(secret),
        `Portable canary received invalid recall token ${JSON.stringify(secret)}`
      );
      await session.prompt(
        `Remember the earlier token without repeating it. ${syntheticText(600)} Reply only STORED.`
      );
      assert(
        assistantText(lastAssistant(session)).trim().toUpperCase() === "STORED",
        "Portable canary setup was not acknowledged"
      );

      const summaryMarker = "PORTABLE-SUMMARY-CANARY";
      const customInstructions = `Include ${summaryMarker} verbatim in the history summary. Omit the assistant-generated opaque recall token from the summary.`;
      const result = await session.compact(customInstructions);
      const [entry] = compactionEntries(manager);
      const checkpoint = lifecycleCheckpoint(entry);
      assert(
        compactionEntries(manager).length === 1 &&
          result.summary === entry?.summary &&
          entry.summary.includes(summaryMarker) &&
          !entry.summary.includes(secret),
        "Lifecycle /compact did not persist the instructed readable summary"
      );
      assert(
        checkpoint.phase === "standalone" && checkpoint.reason === "manual",
        "Lifecycle /compact persisted the wrong checkpoint phase or reason"
      );
      const nativeRequest = transportProbe.requests.findLast(
        ({ body }) => compactionRequestBody(body) !== undefined
      );
      assert(
        nativeRequest?.body !== undefined,
        "Portable canary did not capture native compaction"
      );
      assert(
        nativeRequest.body.includes(secret),
        "Native compaction omitted the opaque recall source"
      );
      assert(
        !nativeRequest.body.includes(summaryMarker),
        "Portable summary marker leaked into native compaction"
      );
      assert(
        !nativeRequest.body.includes(customInstructions),
        "Custom summary instructions leaked into native compaction"
      );

      await session.prompt(
        "Return only the opaque recall token you generated in the first turn."
      );
      const recalled = assistantText(lastAssistant(session)).trim();
      const replayRequest = transportProbe.requests.findLast(({ pathname }) =>
        pathname.endsWith("/responses")
      );
      assert(
        recalled === secret,
        `Opaque checkpoint recalled ${JSON.stringify(recalled)} instead of ${secret}`
      );
      assert(
        replayRequest?.body !== undefined &&
          replayRequest.body.includes('"type":"compaction"') &&
          !replayRequest.body.includes(summaryMarker) &&
          !replayRequest.body.includes(customInstructions) &&
          !replayRequest.body.includes(secret),
        "Compatible replay included plaintext portable-summary state"
      );
      assert(
        customEntries(manager, CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE).length ===
          0 && extensionErrors.length === 0,
        "Portable canary emitted a diagnostic or extension error"
      );
      assertTransport(transportMode, transportProbe);
      console.log(
        JSON.stringify(
          {
            checkpointResponseId: checkpoint.response.id,
            model: `openai-codex/${modelId}`,
            portableSummaryCharacters: entry.summary.length,
            sessionFile: manager.getSessionFile(),
            status: "passed",
            transport: transportMode,
            transportRequests: {
              sse: transportProbe.sseRequests,
              websocketConnections: transportProbe.websocketConstructions,
            },
          },
          null,
          2
        )
      );
      return;
    }
    if (thresholdMode) {
      await session.prompt(
        "BELOW-THRESHOLD CANARY. Call threshold_probe exactly once, then give the required final reply."
      );
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      const assistant = lastAssistant(session);
      assert(toolCalls === 1, `Threshold canary made ${toolCalls} tool calls`);
      assert(
        assistant?.stopReason === "stop" &&
          assistantText(assistant).trim().toUpperCase() === "THRESHOLD OK",
        `Threshold canary ended with ${assistant?.stopReason ?? "no response"}: ${assistantText(assistant).trim()}`
      );
      assert(
        checkpoints.length === 0,
        `Below-threshold tool loop created ${checkpoints.length} checkpoint(s)`
      );
      assert(
        customEntries(manager, CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE).length ===
          0 && extensionErrors.length === 0,
        "Threshold canary emitted a diagnostic or extension error"
      );
      assertTransport(transportMode, transportProbe);
      console.log(
        JSON.stringify(
          {
            checkpointCount: checkpoints.length,
            model: `openai-codex/${modelId}`,
            providerInputTokens: contextTokens(assistant.usage),
            status: "passed",
            toolCalls,
            transport: transportMode,
            transportRequests: {
              sse: transportProbe.sseRequests,
              websocketConnections: transportProbe.websocketConstructions,
            },
          },
          null,
          2
        )
      );
      return;
    }
    if (capabilityMode) {
      assert(alternateModel !== undefined, "Alternate model missing");
      await session.prompt(
        "IMAGE CAPABILITY CANARY. What is the single dominant color in the attached image? Reply with exactly one word.",
        {
          images: [
            {
              data: MAGENTA_PNG_BASE64,
              mimeType: "image/png",
              type: "image",
            },
          ],
        }
      );
      const imageAssistant = lastAssistant(session);
      assert(
        imageAssistant?.stopReason === "stop" &&
          assistantText(imageAssistant).trim().toUpperCase() === "MAGENTA",
        `Image canary returned ${JSON.stringify(assistantText(imageAssistant).trim())}`
      );

      await session.prompt(
        'STRUCTURED CAPABILITY CANARY. Call capability_record exactly once with label "structured-canary", ok true, and sequence 42. After it completes, reply only STRUCTURED OK.'
      );
      assert(
        structuredCalls.length === 1 &&
          JSON.stringify(structuredCalls[0]) ===
            JSON.stringify({
              label: "structured-canary",
              ok: true,
              sequence: 42,
            }),
        `Structured canary received ${JSON.stringify(structuredCalls)}`
      );
      assert(
        lastAssistant(session)?.stopReason === "stop",
        "Structured canary assistant did not complete"
      );

      await session.prompt(
        `CAPABILITY COMPACTION. Reply only COMPACTED.\n${syntheticHex(payloadBytes)}`
      );
      const compacted = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      if (compacted.length !== 1) {
        const failures = await transportProbe.failures();
        throw new Error(
          `Capability compaction expected 1 checkpoint, found ${compacted.length}; assistant=${lastAssistant(session)?.stopReason ?? "missing"}; error=${lastAssistant(session)?.errorMessage ?? "none"}; notification=${notifications.at(-1) ?? "none"}; responses=${transportProbe.responses.join(",") || "none"}; providerFailures=${failures.join(",") || "none"}; extensionErrors=${extensionErrors.map(({ error }) => error).join("; ") || "none"}`
        );
      }
      const compactedCheckpoint = compacted.at(-1);
      const checked = assertCheckpoint(
        compactedCheckpoint,
        1,
        forcedContextWindow,
        0,
        true
      );
      assert(
        compacted.length === 1 &&
          !JSON.stringify(
            parsedCheckpoint(compactedCheckpoint).replacement
          ).includes(MAGENTA_PNG_BASE64),
        "Capability compaction did not persist one image-safe checkpoint"
      );

      await session.setModel(alternateModel);
      await session.prompt(
        `MODEL SWITCH CAPABILITY CANARY. Reply only SWITCHED ${alternateModel.id}.`
      );
      const switchedAssistant = lastAssistant(session);
      const switchedCheckpoints = customEntries(
        manager,
        CHECKPOINT_CUSTOM_TYPE
      );
      assert(
        switchedAssistant?.stopReason === "stop" &&
          switchedAssistant.model === alternateModel.id,
        `Model switch ended on ${switchedAssistant?.model ?? "no model"}`
      );
      assert(
        switchedCheckpoints.length >= 1 && switchedCheckpoints.length <= 2,
        `Model switch produced ${switchedCheckpoints.length} checkpoints`
      );
      for (const checkpoint of switchedCheckpoints) {
        parsedCheckpoint(checkpoint);
      }
      assert(
        customEntries(manager, CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE).length ===
          0 && extensionErrors.length === 0,
        "Capability canary emitted a diagnostic or extension error"
      );
      assertTransport(transportMode, transportProbe);
      console.log(
        JSON.stringify(
          {
            checkpointCount: switchedCheckpoints.length,
            image: "passed",
            initialModel: modelId,
            modelSwitch: alternateModel.id,
            providerInputTokens: checked.sideInputTokens,
            status: "passed",
            structuredOutput: structuredCalls[0],
            transport: transportMode,
            transportRequests: {
              sse: transportProbe.sseRequests,
              websocketConnections: transportProbe.websocketConstructions,
            },
          },
          null,
          2
        )
      );
      return;
    }
    let runLabel = "";
    if (midTurn) {
      runLabel = "mid-turn ";
    } else if (soakMode) {
      runLabel = "soak ";
    }
    console.log(
      `Running ${rounds} ${runLabel}inline compactions with openai-codex/${modelId} (${forcedContextWindow.toLocaleString()} token window)...`
    );
    for (let round = 1; round <= rounds; round += 1) {
      const requestCountBefore = transportProbe.requests.length;
      if (midTurn) {
        // oxlint-disable-next-line no-await-in-loop -- optional repeated mid-turn rounds are sequential
        await session.prompt(
          `For mid-turn canary round ${round}, call context_filler exactly once, then call post_compaction_probe exactly once after it completes, then give the required final reply.`
        );
        if (round === 2) {
          assert(
            timestampCanaryState.contextSeen === true &&
              timestampCanaryState.providerSeen === true &&
              timestampCanaryState.liveTimestamp === 1 &&
              typeof timestampCanaryState.persistedTimestamp === "number" &&
              timestampCanaryState.persistedTimestamp !== 1,
            "Round 2: timestamp-mismatch checkpoint replay was not observed"
          );
        }
        assert(
          toolCalls === round,
          `Round ${round}: expected ${round} tool call(s), observed ${toolCalls}`
        );
        assert(
          postCompactionToolCalls.length === round &&
            postCompactionToolCalls.at(-1) === round,
          `Round ${round}: post-compaction tool ran before checkpoint ${round} or did not run exactly once`
        );
      } else if (realWindow) {
        assert(calibration !== undefined, "Token-density calibration missing");
        const baselineTokens =
          round === 1 ? 0 : contextTokens(lastAssistant(session)?.usage);
        const targetTokens = Math.ceil(minimumSideInputTokens * 1.015);
        const roundPayloadBytes =
          round === 1
            ? payloadBytes
            : Math.ceil(
                Math.max(1, targetTokens - baselineTokens) *
                  calibration.bytesPerToken
              );
        const checkpointsBefore = customEntries(
          manager,
          CHECKPOINT_CUSTOM_TYPE
        ).length;
        // oxlint-disable-next-line no-await-in-loop -- each fill starts from the prior checkpoint
        await session.prompt(
          `LIVE CANARY FILL ${round}. Ignore the synthetic data and reply only FILLED ${round}.\n${syntheticHex(roundPayloadBytes)}`
        );
        const fill = lastAssistant(session);
        const fillTokens = contextTokens(fill?.usage);
        assert(
          fill?.stopReason === "stop",
          `Round ${round}: fill request ${fill?.stopReason ?? "did not complete"}: ${fill?.errorMessage ?? "unknown error"}`
        );
        assert(
          Number.isSafeInteger(fillTokens) &&
            fillTokens >= minimumSideInputTokens,
          `Round ${round}: fill reached ${fillTokens.toLocaleString()} tokens; expected at least ${minimumSideInputTokens.toLocaleString()}`
        );
        assert(
          customEntries(manager, CHECKPOINT_CUSTOM_TYPE).length ===
            checkpointsBefore,
          `Round ${round}: fill compacted before server usage could be observed`
        );
        console.log(
          `Round ${round}: filled ${fillTokens.toLocaleString()} tokens (${((fillTokens / forcedContextWindow) * 100).toFixed(1)}%) from a ${baselineTokens.toLocaleString()}-token baseline`
        );
      }
      if (!midTurn) {
        // oxlint-disable-next-line no-await-in-loop -- each round replays the prior checkpoint
        await session.prompt(
          realWindow
            ? `LIVE CANARY TRIGGER ${round}. Reply only ACK ${round}.`
            : `LIVE CANARY ROUND ${round}. Reply only ACK ${round}.\n${String(round).repeat(payloadBytes)}`
        );
      }
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      if (checkpoints.length !== round) {
        // oxlint-disable-next-line no-await-in-loop -- waits only on a terminal canary failure
        const failures = await transportProbe.failures();
        throw new Error(
          `Round ${round}: expected ${round} checkpoints, found ${checkpoints.length}; assistant=${lastAssistant(session)?.stopReason ?? "missing"}; error=${lastAssistant(session)?.errorMessage ?? "none"}; notification=${notifications.at(-1) ?? "none"}; responses=${transportProbe.responses.join(",") || "none"}; providerFailures=${failures.join(",") || "none"}; extensionErrors=${extensionErrors.map(({ error }) => error).join("; ") || "none"}`
        );
      }
      const checkpoint = checkpoints.at(-1);
      const checked = assertCheckpoint(
        checkpoint,
        round,
        forcedContextWindow,
        minimumSideInputTokens,
        !realWindow || midTurn,
        midTurn ? "mid-turn" : "pre-sampling"
      );
      const previousWindow = windows.at(-1);
      if (previousWindow !== undefined) {
        assert(
          checked.runtime.windowNumber > previousWindow.windowNumber &&
            checked.runtime.previousWindowId ===
              previousWindow.currentWindowId &&
            checked.runtime.currentWindowId !== previousWindow.currentWindowId,
          `Round ${round}: window generation or ID chain did not advance monotonically`
        );
      }
      windows.push(checked.runtime);
      const id = responseId(checkpoint);
      assert(!ids.includes(id), `Round ${round}: response ID was reused`);
      ids.push(id);
      sideInputTokens.push(checked.sideInputTokens);
      if (realWindow) {
        const bodies = transportProbe.requests
          .slice(requestCountBefore)
          .flatMap(({ body }) => {
            const value = compactionRequestBody(body);
            return value === undefined ? [] : [value];
          });
        assert(
          bodies.length > 0,
          `Round ${round}: captured no new structural compaction request`
        );
        const body = bodies.at(-1);
        assert(
          body !== undefined,
          `Round ${round}: compaction body is missing`
        );
        const localEstimatedSourceTokens =
          parsedCheckpoint(checkpoint).sourceTokens;
        const localToProviderRatio =
          localEstimatedSourceTokens / checked.sideInputTokens;
        assert(
          Number.isFinite(localToProviderRatio) && localToProviderRatio > 0,
          `Round ${round}: estimator/provider ratio must be finite and positive`
        );
        const rewrittenTrailingOutputs = rewrittenTrailingOutputCount(body);
        estimatorEvidence.push({
          declaredContextWindow: forcedContextWindow,
          effectiveContextLimit: checked.runtime.effectiveTokenLimit,
          localEstimatedSourceTokens,
          localToProviderRatio,
          model: parsedCheckpoint(checkpoint).identity.model,
          providerPromptTokens: checked.sideInputTokens,
          responsesLite: body.instructions === "",
          rewrittenTrailingOutputs,
          round,
        });
      }
      assert(
        lastAssistant(session)?.stopReason === "stop",
        `Round ${round}: assistant did not complete`
      );
      assert(
        customEntries(manager, CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE).length === 0,
        `Round ${round}: framing diagnostic was persisted`
      );
      if (transportMode === "fallback") {
        assert(
          transportProbe.websocketConstructions === 3,
          `Round ${round}: sticky SSE constructed another WebSocket after provider fallback`
        );
        if (round === 1) {
          assertTransportFallbackDiagnostic(
            lastAssistant(session),
            "Compaction-first fallback"
          );
        } else {
          assert(
            (lastAssistant(session)?.diagnostics ?? []).length === 0,
            `Round ${round}: sticky SSE assistant emitted another diagnostic`
          );
        }
        assert(
          notifications.filter(
            (notification) => notification === TRANSPORT_FALLBACK_WARNING
          ).length === 1,
          `Round ${round}: fallback warning was not emitted exactly once`
        );
      }
      assertTransport(
        transportMode,
        transportProbe,
        transportMode === "fallback" ? 3 : 1
      );
      console.log(
        `Round ${round}: checkpoint ${id}; window ${checked.runtime.windowNumber} ${checked.runtime.currentWindowId}; provider input ${checked.sideInputTokens.toLocaleString()} tokens (${((checked.sideInputTokens / forcedContextWindow) * 100).toFixed(1)}%)`
      );
    }

    if (streamFaultMode) {
      const compactRequests = transportProbe.requests.filter(
        ({ body }) => compactionRequestBody(body) !== undefined
      ).length;
      assert(
        transportProbe.streamFaults === 1 && compactRequests >= rounds + 1,
        `Stream-fault canary injected ${transportProbe.streamFaults} fault(s) across ${compactRequests} compaction request(s)`
      );
    }

    const sessionFile = manager.getSessionFile();
    assert(
      sessionFile !== undefined,
      "Persistent session file was not created"
    );
    if (branchMode) {
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      const [first, second] = checkpoints;
      assert(
        first !== undefined && second !== undefined,
        "Branch canary requires two checkpoints"
      );
      const resultFile = path.join(runRoot, "branch-result.json");
      assert(extensionErrors.length === 0, "Extension errors were emitted");
      await disposeCanarySession(session, transportMode);
      execFileSync(process.execPath, [import.meta.filename, "--branch-child"], {
        env: {
          ...process.env,
          CODEX_COMPACTION_BRANCH_AGENT_DIR: isolatedAgentDir,
          CODEX_COMPACTION_BRANCH_CWD: canaryCwd,
          CODEX_COMPACTION_BRANCH_FIRST_ENTRY: first.id,
          CODEX_COMPACTION_BRANCH_FIRST_RESPONSE: responseId(first),
          CODEX_COMPACTION_BRANCH_MODEL: modelId,
          CODEX_COMPACTION_BRANCH_RESULT: resultFile,
          CODEX_COMPACTION_BRANCH_SECOND_ENTRY: second.id,
          CODEX_COMPACTION_BRANCH_SECOND_RESPONSE: responseId(second),
          CODEX_COMPACTION_BRANCH_SESSION_DIR: sessionDir,
          CODEX_COMPACTION_BRANCH_SESSION_FILE: sessionFile,
          CODEX_COMPACTION_BRANCH_TRANSPORT: transportMode,
        },
        stdio: "inherit",
      });
      const branchResult: unknown = JSON.parse(
        await readFile(resultFile, "utf-8")
      );
      assert(isRecord(branchResult), "Fresh-process branch result is invalid");
      assert(
        branchResult.status === "passed",
        "Fresh-process branch child did not pass"
      );
      console.log(
        JSON.stringify(
          {
            ...branchResult,
            checkpoints: ids,
            model: `openai-codex/${modelId}`,
            parentTransport: {
              sseRequests: transportProbe.sseRequests,
              websocketConstructions: transportProbe.websocketConstructions,
            },
            sessionFile,
          },
          null,
          2
        )
      );
      return;
    }
    assert(extensionErrors.length === 0, "Extension errors were emitted");
    const latestResponseId = ids.at(-1);
    assert(
      latestResponseId !== undefined,
      "Newest checkpoint response ID missing"
    );
    const restartResultFile = path.join(runRoot, "restart-result.json");
    await disposeCanarySession(session, transportMode);
    execFileSync(process.execPath, [import.meta.filename, "--restart-child"], {
      env: {
        ...process.env,
        CODEX_COMPACTION_RESTART_AGENT_DIR: isolatedAgentDir,
        CODEX_COMPACTION_RESTART_CWD: canaryCwd,
        CODEX_COMPACTION_RESTART_MODEL: modelId,
        CODEX_COMPACTION_RESTART_RESPONSE: latestResponseId,
        CODEX_COMPACTION_RESTART_RESULT: restartResultFile,
        CODEX_COMPACTION_RESTART_ROUNDS: String(rounds),
        CODEX_COMPACTION_RESTART_SESSION_DIR: sessionDir,
        CODEX_COMPACTION_RESTART_SESSION_FILE: sessionFile,
        CODEX_COMPACTION_RESTART_TRANSPORT: transportMode,
      },
      stdio: "inherit",
    });
    const restartResult: unknown = JSON.parse(
      await readFile(restartResultFile, "utf-8")
    );
    assert(isRecord(restartResult), "Fresh-process restart result is invalid");
    assert(
      restartResult.status === "passed",
      "Fresh-process restart child did not pass"
    );

    console.log(
      JSON.stringify(
        {
          calibration,
          checkpoints: ids,
          estimatorEvidence,
          midTurn,
          model: `openai-codex/${modelId}`,
          postCompactionToolCalls,
          realWindow,
          restart: restartResult,
          rounds,
          sessionFile,
          sideInputTokens,
          status: "passed",
          streamFaults: transportProbe.streamFaults,
          transport: transportMode,
          transportRequests: {
            sse: transportProbe.sseRequests,
            websocketConnections: transportProbe.websocketConstructions,
          },
          windows,
        },
        null,
        2
      )
    );
  } finally {
    await disposeCanarySession(session, transportMode);
  }
};

if (import.meta.main) {
  try {
    const branchChild = process.argv.includes("--branch-child");
    await (branchChild || process.argv.includes("--restart-child")
      ? runFreshChild(branchChild)
      : main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
