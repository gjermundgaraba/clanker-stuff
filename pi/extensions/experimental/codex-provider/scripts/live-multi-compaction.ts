import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
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
import { Value } from "typebox/value";

import type { Checkpoint, CheckpointInput } from "../checkpoint.ts";
import { CHECKPOINT_CUSTOM_TYPE, parseCheckpoint } from "../checkpoint.ts";
import type {
  ChildInvocation,
  ParentInvocation,
  TransportMode,
} from "./live-multi-compaction-options.ts";
import { parseLiveInvocation, usesRealWindow } from "./live-multi-compaction-options.ts";
import {
  fetchRequestBody,
  fetchRequestUrl,
  FunctionValueSchema,
  isWireRecord as isRecord,
  NumberValueSchema,
  parseCompactionRequestBody,
  StringValueSchema,
} from "./wire.ts";
import type { WireRecord, WireValue } from "./wire.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "index.ts");
const JITI_CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")),
  "lib/jiti-cli.mjs",
);
const TRANSPORT_FALLBACK_WARNING =
  "OpenAI Codex WebSocket is unavailable; using SSE for this session.";
const TRUNCATED_OUTPUT_MESSAGE = "Output exceeded the available model context and was truncated";
const TIMESTAMP_CANARY_TYPE = "live-timestamp-canary";
const TIMESTAMP_CANARY_SENTINEL = "MIDTURN-TIMESTAMP-CANARY-7F3A";
const MAGENTA_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAAA1BMVEX/AP804Oa6AAAAD0lEQVQoz2NgGAWjgHwAAAJAAAGMxat3AAAAAElFTkSuQmCC";

const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const liveUiContext = (notifications: string[]): ExtensionUIContext => {
  const fixture = {
    notify: (message: string) => notifications.push(message),
    select: async () => await Promise.resolve(undefined),
    setStatus: () => null,
  } satisfies Pick<ExtensionUIContext, "notify" | "select" | "setStatus">;
  // SAFETY: Codex provider canaries use only notify, select, and setStatus; all three are implemented.
  return Object.assign({} as ExtensionUIContext, fixture);
};

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
};

const customEntries = (manager: SessionManager, customType: string): CustomEntry[] =>
  manager
    .getBranch()
    .filter(
      (entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType,
    );

const parseLiveCheckpoint = (value: CheckpointInput, label: string): Checkpoint => {
  const parsed = parseCheckpoint(value);
  if (!parsed.ok) {
    throw new Error(`${label}: ${parsed.error}`);
  }
  return parsed.checkpoint;
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

const responseId = (entry: CustomEntry | undefined): string => parsedCheckpoint(entry).response.id;

type CheckpointAssertion = {
  readonly runtime: Checkpoint["runtime"];
  readonly sideInputTokens: number;
};

const assertCheckpoint = (
  entry: CustomEntry | undefined,
  expectedRound: number,
  forcedContextWindow: number,
  minimumSideInputTokens: number,
  requireLocalThreshold: boolean,
  expectedPhase: "mid-turn" | "pre-sampling" = "pre-sampling",
): CheckpointAssertion => {
  const checkpoint = parsedCheckpoint(entry);
  assert(
    checkpoint.phase === expectedPhase && checkpoint.reason === "threshold",
    `Round ${expectedRound}: unexpected checkpoint phase/reason`,
  );
  if (requireLocalThreshold) {
    assert(
      checkpoint.sourceTokens >= Math.floor(forcedContextWindow * 0.9),
      `Round ${expectedRound}: checkpoint source did not cross 90%`,
    );
  }
  const { usage } = checkpoint.response;
  const sideInputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  assert(
    sideInputTokens >= minimumSideInputTokens,
    `Round ${expectedRound}: provider processed ${sideInputTokens} input tokens; expected at least ${minimumSideInputTokens}`,
  );
  assert(
    checkpoint.runtime.windowNumber === expectedRound,
    `Round ${expectedRound}: expected window ${expectedRound}, received ${checkpoint.runtime.windowNumber}`,
  );
  assert(
    checkpoint.runtime.currentWindowId !== checkpoint.runtime.previousWindowId,
    `Round ${expectedRound}: current and previous window IDs match`,
  );
  return { runtime: checkpoint.runtime, sideInputTokens };
};

const lastAssistant = (session: AgentSession): AssistantMessage | undefined =>
  session.messages.findLast((message): message is AssistantMessage => message.role === "assistant");

const assistantText = (message: AssistantMessage | undefined) =>
  message?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ?? "";

const rewrittenTrailingOutputCount = (requestBodyValue: WireValue): number => {
  assert(isRecord(requestBodyValue), "Compaction request body is invalid");
  assert(Array.isArray(requestBodyValue.input), "Compaction input is missing");
  return requestBodyValue.input.filter((item) => {
    if (!isRecord(item)) {
      return false;
    }
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") {
      return (
        item.type === "tool_search_output" && Array.isArray(item.tools) && item.tools.length === 0
      );
    }
    return isRecord(item.output)
      ? item.output.body === TRUNCATED_OUTPUT_MESSAGE
      : item.output === TRUNCATED_OUTPUT_MESSAGE;
  }).length;
};

const disposedSessions = new WeakSet<AgentSession>();

const disposeCanarySession = async (session: AgentSession, transportMode: TransportMode) => {
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
  assert(value !== undefined && value.length > 0, `${name} is required`);
  return value;
};

export const installTransportProbe = (
  mode: TransportMode,
  forceSse = false,
  injectStreamFault = false,
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
        const value: WireValue = JSON.parse(line.slice(6));
        if (!isRecord(value) || !Value.Check(StringValueSchema, value.type)) {
          continue;
        }
        const responseValue = isRecord(value.response) ? value.response : undefined;
        if (value.type !== "response.failed") {
          continue;
        }
        const errorValue = isRecord(responseValue?.error) ? responseValue.error : undefined;
        failures.push(
          Value.Check(StringValueSchema, errorValue?.code) ? errorValue.code : "response.failed",
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
    const { pathname } = new URL(fetchRequestUrl(input));
    const observed = pathname.endsWith("/responses") || pathname.endsWith("/responses/compact");
    const body = await fetchRequestBody(input, init);
    const compactionRequest = parseCompactionRequestBody(body) !== undefined;
    let response = await nativeFetch(input, init);
    if (observed) {
      sseRequests += 1;
      requests.push({ body, pathname });
      responses.push(`${pathname}:${response.status}`);
      if (injectStreamFault && streamFaults === 0 && compactionRequest && response.body !== null) {
        streamFaults += 1;
        const reader = response.body.getReader();
        const faultBody = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const first = await reader.read();
            if (first.done !== true) {
              const { value } = first;
              assert(value instanceof Uint8Array, "Response chunk is not bytes");
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
  } else if (Value.Check(FunctionValueSchema, globalThis.WebSocket)) {
    const NativeWebSocket = globalThis.WebSocket;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: new Proxy(NativeWebSocket, {
        construct(target, argumentsList) {
          websocketConstructions += 1;
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
  expectedFallbackConstructions = 1,
) => {
  if (mode === "websocket") {
    assert(
      probe.websocketConstructions > 0 && probe.sseRequests === 0,
      `WebSocket canary used ${probe.sseRequests} SSE request(s) across ${probe.websocketConstructions} WebSocket connection(s)`,
    );
  } else if (mode === "fallback") {
    assert(
      probe.websocketConstructions === expectedFallbackConstructions,
      `Fallback canary used ${probe.websocketConstructions} WebSocket attempt(s) and ${probe.sseRequests} SSE request(s)`,
    );
  } else {
    assert(
      probe.websocketConstructions === 0,
      `SSE canary used ${probe.websocketConstructions} WebSocket connection(s) and ${probe.sseRequests} SSE request(s)`,
    );
  }
};

const runFreshChild = async (invocation: ChildInvocation) => {
  const prefix =
    invocation.kind === "branch-child" ? "CODEX_COMPACTION_BRANCH" : "CODEX_COMPACTION_RESTART";
  const environment = (name: string) => requiredEnvironment(`${prefix}_${name}`);
  const canaryCwd = environment("CWD");
  const isolatedAgentDir = environment("AGENT_DIR");
  const modelId = environment("MODEL");
  const resultFile = environment("RESULT");
  const sessionDir = environment("SESSION_DIR");
  const sessionFile = environment("SESSION_FILE");
  const { transport: transportMode } = invocation;
  const transportProbe = installTransportProbe(transportMode);
  const realAgentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(realAgentDir, "auth.json"),
    modelsPath: path.join(realAgentDir, "models.json"),
  });
  const baseModel = modelRuntime.getModel("openai-codex", modelId);
  assert(baseModel !== undefined, `Model openai-codex/${modelId} is unavailable`);
  const extensionErrors: ExtensionError[] = [];
  const notifications: string[] = [];
  const openSession = async (
    manager: SessionManager,
    contextWindow: number,
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
      systemPrompt: `This is a fresh-process ${invocation.kind === "branch-child" ? "branch" : "restart"} canary. Reply with one short acknowledgement and do not use tools.`,
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
      uiContext: liveUiContext(notifications),
    });
    if (created.session.model?.contextWindow !== contextWindow) {
      await created.session.setModel({ ...baseModel, contextWindow });
    }
    assert(
      created.session.model?.contextWindow === contextWindow,
      `Fresh-process model window is ${created.session.model?.contextWindow ?? "missing"}; expected ${contextWindow}`,
    );
    return created.session;
  };

  let manager = SessionManager.open(sessionFile, sessionDir, canaryCwd);
  let session = await openSession(
    manager,
    invocation.kind === "branch-child" ? 4096 : Math.max(baseModel.contextWindow, 1_000_000),
  );
  try {
    if (invocation.kind === "restart-child") {
      const expectedResponseId = environment("RESPONSE");
      const expectedRounds = Number(environment("ROUNDS"));
      assert(
        Number.isSafeInteger(expectedRounds) && expectedRounds >= 1,
        "Fresh-process checkpoint count is invalid",
      );
      await session.prompt("FRESH PROCESS RESUME ONE. Reply only RESUMED ONE.");
      const fallbackAfterFirst = transportProbe.websocketConstructions;
      await session.prompt("FRESH PROCESS RESUME TWO. Reply only RESUMED TWO.");
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      assert(
        checkpoints.length === expectedRounds &&
          responseId(checkpoints.at(-1)) === expectedResponseId,
        "Fresh-process restart unexpectedly created, lost, or replaced a checkpoint",
      );
      parsedCheckpoint(checkpoints.at(-1));
      assert(
        lastAssistant(session)?.stopReason === "stop",
        "Fresh-process restart assistant did not complete",
      );
      assert(extensionErrors.length === 0, "Extension errors were emitted");
      if (transportMode === "fallback") {
        assert(
          notifications.filter((notification) => notification === TRANSPORT_FALLBACK_WARNING)
            .length === 1,
          "Fresh-process fallback warning was not emitted exactly once",
        );
        assert(
          fallbackAfterFirst === 1 && transportProbe.websocketConstructions === fallbackAfterFirst,
          `Fresh-process fallback made ${fallbackAfterFirst} WebSocket attempt(s) on the first turn and ${transportProbe.websocketConstructions} total`,
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
        }),
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
      activeCheckpoints.length === 1 && responseId(activeCheckpoint) === firstResponseId,
      "Checkpoint 1 was not active after the fresh-process fork",
    );
    const firstWindow = parsedCheckpoint(activeCheckpoint).runtime;
    await session.prompt(`FRESH PROCESS DIVERGENT BRANCH.\n${"d".repeat(20_000)}`);
    const divergentCheckpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    assert(
      divergentCheckpoints.length === 2 &&
        responseId(divergentCheckpoints[0]) === firstResponseId &&
        responseId(divergentCheckpoints[1]) !== secondResponseId,
      "Divergent branch reused or retained checkpoint 2",
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
      "Divergent checkpoint window did not advance from checkpoint 1",
    );
    assert(
      lastAssistant(session)?.stopReason === "stop",
      "Divergent branch assistant did not complete",
    );
    assertTransport(transportMode, transportProbe);
    await disposeCanarySession(session, transportMode);

    manager = SessionManager.open(sessionFile, sessionDir, canaryCwd);
    session = await openSession(manager, Math.max(baseModel.contextWindow, 1_000_000));
    await session.navigateTree(secondEntryId, { summarize: false });
    await session.prompt("FRESH PROCESS ORIGINAL BRANCH. Reply only ORIGINAL.");
    const originalCheckpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    assert(
      originalCheckpoints.length === 2 &&
        responseId(originalCheckpoints[0]) === firstResponseId &&
        responseId(originalCheckpoints[1]) === secondResponseId,
      "Original branch did not retain checkpoint 2",
    );
    assert(
      !originalCheckpoints.some((entry) => responseId(entry) === divergentResponseId),
      "Divergent checkpoint leaked into the original branch",
    );
    assert(
      lastAssistant(session)?.stopReason === "stop",
      "Original branch assistant did not complete",
    );
    assertTransport(transportMode, transportProbe, transportMode === "fallback" ? 2 : 1);
    await session.navigateTree(divergentEntryId, { summarize: false });
    const restoredDivergent = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
    assert(
      restoredDivergent.length === 2 &&
        responseId(restoredDivergent[1]) === divergentResponseId &&
        !restoredDivergent.some((entry) => responseId(entry) === secondResponseId),
      "Divergent branch was not independently restorable",
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
      }),
    );
  } finally {
    await disposeCanarySession(session, transportMode);
  }
};

const main = async (invocation: ParentInvocation) => {
  const scenario = invocation.kind;
  const { rounds, transport: transportMode } = invocation;
  if (invocation.showHelp) {
    console.log(`Usage:
  vp run @clanker-stuff/codex-provider#test:live [--sse|--websocket|--fallback] [--branch|--capabilities|--real-window|--mid-turn|--soak|--stream-fault|--threshold]

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
    configuredModel !== undefined && configuredModel.length > 0 ? configuredModel : "gpt-5.6-sol";
  execFileSync(
    process.execPath,
    [JITI_CLI, path.join(PACKAGE_ROOT, "audit-local-order.ts"), process.cwd()],
    { stdio: "inherit" },
  );

  const artifactParent = path.resolve(process.env.CODEX_COMPACTION_LIVE_DIR ?? os.tmpdir());
  await mkdir(artifactParent, { recursive: true });
  const runRoot = await mkdtemp(path.join(artifactParent, "codex-provider-live-"));
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
  assert(baseModel !== undefined, `Model openai-codex/${modelId} is unavailable`);
  assert(
    baseModel.api === "openai-codex-responses",
    `Model ${modelId} does not use openai-codex-responses`,
  );
  const auth = await modelRuntime.getAuth(baseModel);
  assert(auth !== undefined, "OpenAI Codex auth is unavailable");
  const alternateValue = process.env.CODEX_COMPACTION_LIVE_ALT_MODEL?.trim();
  const configuredAlternate =
    alternateValue !== undefined && alternateValue.length > 0 ? alternateValue : undefined;
  const availableModels = scenario === "capabilities" ? await modelRuntime.getAvailable() : [];
  const alternateCandidates =
    scenario === "capabilities"
      ? availableModels.filter(
          (candidate) =>
            candidate.provider === "openai-codex" &&
            candidate.api === "openai-codex-responses" &&
            candidate.id !== modelId,
        )
      : [];
  const alternateModel =
    scenario === "capabilities"
      ? (alternateCandidates.find(({ id }) => id === (configuredAlternate ?? "gpt-5.6-terra")) ??
        (configuredAlternate === undefined ? alternateCandidates[0] : undefined))
      : undefined;
  if (scenario === "capabilities") {
    assert(baseModel.input.includes("image"), `Capability model ${modelId} does not accept images`);
    assert(
      alternateModel !== undefined,
      configuredAlternate === undefined
        ? "No alternate OpenAI Codex model is available"
        : `Alternate model openai-codex/${configuredAlternate} is unavailable`,
    );
  }
  const forcedContextWindow =
    usesRealWindow(scenario) || scenario === "threshold"
      ? baseModel.contextWindow
      : positiveInteger("CODEX_COMPACTION_LIVE_CONTEXT_WINDOW", 4096);
  let payloadBytes =
    usesRealWindow(scenario) || scenario === "threshold"
      ? 0
      : positiveInteger("CODEX_COMPACTION_LIVE_PAYLOAD_BYTES", 20_000);
  if (!(usesRealWindow(scenario) || scenario === "threshold")) {
    assert(
      payloadBytes >= forcedContextWindow * 0.9 * 4,
      "Synthetic payload must cross the 90% local context estimate",
    );
  }
  const minimumSideInputTokens = usesRealWindow(scenario)
    ? Math.floor(forcedContextWindow * (scenario === "mid-turn" ? 0.8 : 0.9))
    : 0;

  const extensionErrors: ExtensionError[] = [];
  const notifications: string[] = [];
  type TimestampCanaryState = {
    contextSeen?: boolean;
    liveTimestamp?: number;
    persistedTimestamp?: number;
    providerSeen?: boolean;
  };
  const timestampCanaryState: TimestampCanaryState = {};
  const timestampCanaryExtension: ExtensionFactory = (pi) => {
    let injected = false;
    pi.on("before_agent_start", (event) => {
      const shouldInject = !injected && event.prompt.includes("mid-turn canary round 2");
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
      if (event.message.role === "custom" && event.message.customType === TIMESTAMP_CANARY_TYPE) {
        event.message.timestamp = 1;
      }
    });
    pi.on("context", (event, ctx) => {
      const live = event.messages.find(
        (message) => message.role === "custom" && message.customType === TIMESTAMP_CANARY_TYPE,
      );
      if (live === undefined) {
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const persisted = branch.find(
        (entry) => entry.type === "custom_message" && entry.customType === TIMESTAMP_CANARY_TYPE,
      );
      assert(
        persisted !== undefined &&
          live.timestamp !== new Date(persisted.timestamp).getTime() &&
          branch.some(
            (entry) => entry.type === "custom" && entry.customType === CHECKPOINT_CUSTOM_TYPE,
          ),
        "Timestamp canary did not precede active checkpoint replay",
      );
      timestampCanaryState.contextSeen = true;
      timestampCanaryState.liveTimestamp = live.timestamp;
      timestampCanaryState.persistedTimestamp = new Date(persisted.timestamp).getTime();
    });
    pi.on("before_provider_request", (event) => {
      const payload = JSON.stringify(event.payload);
      if (!payload.includes(TIMESTAMP_CANARY_SENTINEL)) {
        return;
      }
      assert(
        payload.split(TIMESTAMP_CANARY_SENTINEL).length === 2 &&
          payload.split('"type":"compaction"').length === 2,
        "Timestamp canary duplicated sentinel or opaque state",
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
  ): Promise<AgentSession> => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      transport: transportMode === "sse" ? "sse" : "websocket",
    });
    const resourceLoader = new DefaultResourceLoader({
      additionalExtensionPaths: loadCompaction ? [EXTENSION_PATH] : [],
      agentDir: isolatedAgentDir,
      cwd: canaryCwd,
      extensionFactories:
        loadCompaction && scenario === "mid-turn" ? [timestampCanaryExtension] : [],
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
      `Extension loading failed: ${loaded.errors.map(({ error }) => error).join("; ")}`,
    );
    if (loadCompaction) {
      assert(
        loaded.extensions.some(
          (extension) => path.resolve(extension.resolvedPath) === EXTENSION_PATH,
        ),
        "codex-provider extension was not loaded",
      );
    }
    const toolOptions: Pick<CreateAgentSessionOptions, "customTools" | "noTools" | "tools"> =
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
      uiContext: liveUiContext(notifications),
    });
    if (created.session.model?.contextWindow !== contextWindow) {
      await created.session.setModel({ ...baseModel, contextWindow });
    }
    assert(
      created.session.model?.contextWindow === contextWindow,
      `Canary model window is ${created.session.model?.contextWindow ?? "missing"}; expected ${contextWindow}`,
    );
    return created.session;
  };

  let calibration: { bytesPerToken: number; inputTokens: number; probeBytes: number } | undefined;
  if (usesRealWindow(scenario)) {
    const probeBytes = 64_000;
    const syntheticPayload = scenario === "mid-turn" ? syntheticText : syntheticHex;
    const probeManager = SessionManager.inMemory(canaryCwd);
    const probe = await createCanarySession(probeManager, forcedContextWindow, false);
    try {
      await probe.prompt(
        `TOKEN DENSITY CALIBRATION. Reply only CALIBRATED.\n${syntheticPayload(probeBytes)}`,
      );
      const probeResult = lastAssistant(probe);
      const probeTokens = contextTokens(probeResult?.usage);
      assert(
        probeResult?.stopReason === "stop" && Number.isSafeInteger(probeTokens) && probeTokens > 0,
        "Token-density calibration request failed",
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
      scenario === "mid-turn"
        ? Math.max(
            Math.ceil(forcedContextWindow * 0.9 * 4 * 1.005),
            Math.ceil(minimumSideInputTokens * 1.02 * calibration.bytesPerToken),
          )
        : Math.ceil(minimumSideInputTokens * 1.015 * calibration.bytesPerToken),
    );
    if (scenario === "mid-turn") {
      assert(
        Math.ceil(payloadBytes / 4) >= Math.floor(forcedContextWindow * 0.9),
        "Mid-turn tool output does not cross the local compaction threshold",
      );
    } else {
      assert(
        Math.ceil(payloadBytes / 4) < minimumSideInputTokens,
        "Calibrated payload would trigger the local estimator before server usage",
      );
    }
    console.log(
      `Calibration: ${calibration.inputTokens.toLocaleString()} tokens / ${probeBytes.toLocaleString()} bytes; ${calibration.bytesPerToken.toFixed(3)} bytes/token`,
    );
  }

  const transportProbe = installTransportProbe(transportMode, false, scenario === "stream-fault");
  const manager = SessionManager.create(canaryCwd, sessionDir);
  let toolCalls = 0;
  const postCompactionToolCalls: number[] = [];
  const structuredCalls: WireRecord[] = [];
  const midTurnTool: ToolDefinition = {
    description: "Return the synthetic context payload. Call exactly once when instructed.",
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
    description: "Confirm tool availability after context_filler has caused compaction.",
    execute: async () => {
      postCompactionToolCalls.push(customEntries(manager, CHECKPOINT_CUSTOM_TYPE).length);
      return {
        content: [{ text: "post-compaction tool probe complete", type: "text" }],
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
    description: "Record the exact structured capability-canary payload requested by the user.",
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
  if (scenario === "capabilities") {
    customTools = [structuredTool];
  } else if (scenario === "mid-turn") {
    customTools = [midTurnTool, postCompactionTool];
  } else if (scenario === "threshold") {
    customTools = [thresholdTool];
  }
  let systemPrompt: string | undefined;
  if (scenario === "capabilities") {
    systemPrompt =
      "This is a backend capability canary. Follow each user request exactly. Use capability_record only when explicitly requested.";
  } else if (scenario === "threshold") {
    systemPrompt =
      "This is a below-threshold metadata canary. Call threshold_probe exactly once when requested, then reply only THRESHOLD OK.";
  } else if (scenario === "mid-turn") {
    systemPrompt =
      "For every user request, first call context_filler exactly once. Only after that tool completes, call post_compaction_probe exactly once, then reply only MIDTURN COMPLETE. Never call either tool more than once for one request.";
  }
  const session = await createCanarySession(
    manager,
    forcedContextWindow,
    true,
    customTools,
    systemPrompt,
  );
  if (scenario === "threshold") {
    const provider = modelRuntime.getProvider("openai-codex");
    assert(
      provider?.refreshModels !== undefined,
      "Threshold canary provider cannot refresh models",
    );
    const { apiKey } = auth.auth;
    assert(apiKey !== undefined, "Threshold canary auth is unavailable");
    type StoreEntry = NonNullable<
      Parameters<NonNullable<typeof provider.refreshModels>>[0]["stored"]
    >;
    let stored: StoreEntry | undefined;
    await provider.refreshModels({
      allowNetwork: true,
      credential: { env: auth.env, key: apiKey, type: "api_key" },
      force: true,
      publish: async (publication) => {
        if (publication.persist === null) {
          stored = undefined;
        } else if (publication.persist !== undefined) {
          stored = publication.persist;
        }
        publication.update?.();
        return true;
      },
      signal: AbortSignal.timeout(30_000),
      stored,
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
    if (scenario === "threshold") {
      await session.prompt(
        "BELOW-THRESHOLD CANARY. Call threshold_probe exactly once, then give the required final reply.",
      );
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      const assistant = lastAssistant(session);
      assert(toolCalls === 1, `Threshold canary made ${toolCalls} tool calls`);
      assert(
        assistant?.stopReason === "stop" &&
          assistantText(assistant).trim().toUpperCase() === "THRESHOLD OK",
        `Threshold canary ended with ${assistant?.stopReason ?? "no response"}: ${assistantText(assistant).trim()}`,
      );
      assert(
        checkpoints.length === 0,
        `Below-threshold tool loop created ${checkpoints.length} checkpoint(s)`,
      );
      assert(extensionErrors.length === 0, "Threshold canary emitted an extension error");
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
          2,
        ),
      );
      return;
    }
    if (scenario === "capabilities") {
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
        },
      );
      const imageAssistant = lastAssistant(session);
      assert(
        imageAssistant?.stopReason === "stop" &&
          assistantText(imageAssistant).trim().toUpperCase() === "MAGENTA",
        `Image canary returned ${JSON.stringify(assistantText(imageAssistant).trim())}`,
      );

      await session.prompt(
        'STRUCTURED CAPABILITY CANARY. Call capability_record exactly once with label "structured-canary", ok true, and sequence 42. After it completes, reply only STRUCTURED OK.',
      );
      assert(
        structuredCalls.length === 1 &&
          JSON.stringify(structuredCalls[0]) ===
            JSON.stringify({
              label: "structured-canary",
              ok: true,
              sequence: 42,
            }),
        `Structured canary received ${JSON.stringify(structuredCalls)}`,
      );
      assert(
        lastAssistant(session)?.stopReason === "stop",
        "Structured canary assistant did not complete",
      );

      await session.prompt(
        `CAPABILITY COMPACTION. Reply only COMPACTED.\n${syntheticHex(payloadBytes)}`,
      );
      const compacted = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      if (compacted.length !== 1) {
        const failures = await transportProbe.failures();
        throw new Error(
          `Capability compaction expected 1 checkpoint, found ${compacted.length}; assistant=${lastAssistant(session)?.stopReason ?? "missing"}; error=${lastAssistant(session)?.errorMessage ?? "none"}; notification=${notifications.at(-1) ?? "none"}; responses=${transportProbe.responses.join(",") || "none"}; providerFailures=${failures.join(",") || "none"}; extensionErrors=${extensionErrors.map(({ error }) => error).join("; ") || "none"}`,
        );
      }
      const compactedCheckpoint = compacted.at(-1);
      const checked = assertCheckpoint(compactedCheckpoint, 1, forcedContextWindow, 0, true);
      assert(
        compacted.length === 1 &&
          !JSON.stringify(parsedCheckpoint(compactedCheckpoint).replacement).includes(
            MAGENTA_PNG_BASE64,
          ),
        "Capability compaction did not persist one image-safe checkpoint",
      );

      await session.setModel(alternateModel);
      await session.prompt(
        `MODEL SWITCH CAPABILITY CANARY. Reply only SWITCHED ${alternateModel.id}.`,
      );
      const switchedAssistant = lastAssistant(session);
      const switchedCheckpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      assert(
        switchedAssistant?.stopReason === "stop" && switchedAssistant.model === alternateModel.id,
        `Model switch ended on ${switchedAssistant?.model ?? "no model"}`,
      );
      assert(
        switchedCheckpoints.length >= 1 && switchedCheckpoints.length <= 2,
        `Model switch produced ${switchedCheckpoints.length} checkpoints`,
      );
      for (const checkpoint of switchedCheckpoints) {
        parsedCheckpoint(checkpoint);
      }
      assert(extensionErrors.length === 0, "Capability canary emitted an extension error");
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
          2,
        ),
      );
      return;
    }
    let runLabel = "";
    if (scenario === "mid-turn") {
      runLabel = "mid-turn ";
    } else if (scenario === "soak") {
      runLabel = "soak ";
    }
    console.log(
      `Running ${rounds} ${runLabel}inline compactions with openai-codex/${modelId} (${forcedContextWindow.toLocaleString()} token window)...`,
    );
    for (let round = 1; round <= rounds; round += 1) {
      const requestCountBefore = transportProbe.requests.length;
      if (scenario === "mid-turn") {
        await session.prompt(
          `For mid-turn canary round ${round}, call context_filler exactly once, then call post_compaction_probe exactly once after it completes, then give the required final reply.`,
        );
        if (round === 2) {
          assert(
            timestampCanaryState.contextSeen === true &&
              timestampCanaryState.providerSeen === true &&
              timestampCanaryState.liveTimestamp === 1 &&
              Value.Check(NumberValueSchema, timestampCanaryState.persistedTimestamp) &&
              timestampCanaryState.persistedTimestamp !== 1,
            "Round 2: timestamp-mismatch checkpoint replay was not observed",
          );
        }
        assert(
          toolCalls === round,
          `Round ${round}: expected ${round} tool call(s), observed ${toolCalls}`,
        );
        assert(
          postCompactionToolCalls.length === round && postCompactionToolCalls.at(-1) === round,
          `Round ${round}: post-compaction tool ran before checkpoint ${round} or did not run exactly once`,
        );
      } else if (usesRealWindow(scenario)) {
        assert(calibration !== undefined, "Token-density calibration missing");
        const baselineTokens = round === 1 ? 0 : contextTokens(lastAssistant(session)?.usage);
        const targetTokens = Math.ceil(minimumSideInputTokens * 1.015);
        const roundPayloadBytes =
          round === 1
            ? payloadBytes
            : Math.ceil(Math.max(1, targetTokens - baselineTokens) * calibration.bytesPerToken);
        const checkpointsBefore = customEntries(manager, CHECKPOINT_CUSTOM_TYPE).length;
        await session.prompt(
          `LIVE CANARY FILL ${round}. Ignore the synthetic data and reply only FILLED ${round}.\n${syntheticHex(roundPayloadBytes)}`,
        );
        const fill = lastAssistant(session);
        const fillTokens = contextTokens(fill?.usage);
        assert(
          fill?.stopReason === "stop",
          `Round ${round}: fill request ${fill?.stopReason ?? "did not complete"}: ${fill?.errorMessage ?? "unknown error"}`,
        );
        assert(
          Number.isSafeInteger(fillTokens) && fillTokens >= minimumSideInputTokens,
          `Round ${round}: fill reached ${fillTokens.toLocaleString()} tokens; expected at least ${minimumSideInputTokens.toLocaleString()}`,
        );
        assert(
          customEntries(manager, CHECKPOINT_CUSTOM_TYPE).length === checkpointsBefore,
          `Round ${round}: fill compacted before server usage could be observed`,
        );
        console.log(
          `Round ${round}: filled ${fillTokens.toLocaleString()} tokens (${((fillTokens / forcedContextWindow) * 100).toFixed(1)}%) from a ${baselineTokens.toLocaleString()}-token baseline`,
        );
      }
      if (scenario !== "mid-turn") {
        await session.prompt(
          usesRealWindow(scenario)
            ? `LIVE CANARY TRIGGER ${round}. Reply only ACK ${round}.`
            : `LIVE CANARY ROUND ${round}. Reply only ACK ${round}.\n${String(round).repeat(payloadBytes)}`,
        );
      }
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      if (checkpoints.length !== round) {
        const failures = await transportProbe.failures();
        throw new Error(
          `Round ${round}: expected ${round} checkpoints, found ${checkpoints.length}; assistant=${lastAssistant(session)?.stopReason ?? "missing"}; error=${lastAssistant(session)?.errorMessage ?? "none"}; notification=${notifications.at(-1) ?? "none"}; responses=${transportProbe.responses.join(",") || "none"}; providerFailures=${failures.join(",") || "none"}; extensionErrors=${extensionErrors.map(({ error }) => error).join("; ") || "none"}`,
        );
      }
      const checkpoint = checkpoints.at(-1);
      const checked = assertCheckpoint(
        checkpoint,
        round,
        forcedContextWindow,
        minimumSideInputTokens,
        !usesRealWindow(scenario) || scenario === "mid-turn",
        scenario === "mid-turn" ? "mid-turn" : "pre-sampling",
      );
      const previousWindow = windows.at(-1);
      if (previousWindow !== undefined) {
        assert(
          checked.runtime.windowNumber > previousWindow.windowNumber &&
            checked.runtime.previousWindowId === previousWindow.currentWindowId &&
            checked.runtime.currentWindowId !== previousWindow.currentWindowId,
          `Round ${round}: window generation or ID chain did not advance monotonically`,
        );
      }
      windows.push(checked.runtime);
      const id = responseId(checkpoint);
      assert(!ids.includes(id), `Round ${round}: response ID was reused`);
      ids.push(id);
      sideInputTokens.push(checked.sideInputTokens);
      if (usesRealWindow(scenario)) {
        const bodies = transportProbe.requests.slice(requestCountBefore).flatMap(({ body }) => {
          const value = parseCompactionRequestBody(body);
          return value === undefined ? [] : [value];
        });
        assert(bodies.length > 0, `Round ${round}: captured no new structural compaction request`);
        const body = bodies.at(-1);
        assert(body !== undefined, `Round ${round}: compaction body is missing`);
        const localEstimatedSourceTokens = parsedCheckpoint(checkpoint).sourceTokens;
        const localToProviderRatio = localEstimatedSourceTokens / checked.sideInputTokens;
        assert(
          Number.isFinite(localToProviderRatio) && localToProviderRatio > 0,
          `Round ${round}: estimator/provider ratio must be finite and positive`,
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
        `Round ${round}: assistant did not complete`,
      );
      if (transportMode === "fallback") {
        assert(
          transportProbe.websocketConstructions === 3,
          `Round ${round}: sticky SSE constructed another WebSocket after provider fallback`,
        );
        assert(
          notifications.filter((notification) => notification === TRANSPORT_FALLBACK_WARNING)
            .length === 1,
          `Round ${round}: fallback warning was not emitted exactly once`,
        );
      }
      assertTransport(transportMode, transportProbe, transportMode === "fallback" ? 3 : 1);
      console.log(
        `Round ${round}: checkpoint ${id}; window ${checked.runtime.windowNumber} ${checked.runtime.currentWindowId}; provider input ${checked.sideInputTokens.toLocaleString()} tokens (${((checked.sideInputTokens / forcedContextWindow) * 100).toFixed(1)}%)`,
      );
    }

    const entriesBeforeStatus = manager.getEntries().length;
    await session.prompt("/codex-provider");
    const statusReport = notifications.findLast((notification) =>
      notification.startsWith("Codex provider status\n"),
    );
    assert(
      statusReport?.includes(`Count: ${rounds} current branch`) === true &&
        manager.getEntries().length === entriesBeforeStatus,
      "Codex provider status did not report the live checkpoints without changing the session",
    );

    if (scenario === "stream-fault") {
      const compactRequests = transportProbe.requests.filter(
        ({ body }) => parseCompactionRequestBody(body) !== undefined,
      ).length;
      assert(
        transportProbe.streamFaults === 1 && compactRequests >= rounds + 1,
        `Stream-fault canary injected ${transportProbe.streamFaults} fault(s) across ${compactRequests} compaction request(s)`,
      );
    }

    const sessionFile = manager.getSessionFile();
    assert(sessionFile !== undefined, "Persistent session file was not created");
    if (scenario === "branch") {
      const checkpoints = customEntries(manager, CHECKPOINT_CUSTOM_TYPE);
      const [first, second] = checkpoints;
      assert(first !== undefined && second !== undefined, "Branch canary requires two checkpoints");
      const resultFile = path.join(runRoot, "branch-result.json");
      assert(extensionErrors.length === 0, "Extension errors were emitted");
      await disposeCanarySession(session, transportMode);
      execFileSync(process.execPath, [JITI_CLI, import.meta.filename, "--branch-child"], {
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
      const branchResult: unknown = JSON.parse(await readFile(resultFile, "utf-8"));
      assert(isRecord(branchResult), "Fresh-process branch result is invalid");
      assert(branchResult.status === "passed", "Fresh-process branch child did not pass");
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
          2,
        ),
      );
      return;
    }
    assert(extensionErrors.length === 0, "Extension errors were emitted");
    const latestResponseId = ids.at(-1);
    assert(latestResponseId !== undefined, "Newest checkpoint response ID missing");
    const restartResultFile = path.join(runRoot, "restart-result.json");
    await disposeCanarySession(session, transportMode);
    execFileSync(process.execPath, [JITI_CLI, import.meta.filename, "--restart-child"], {
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
    const restartResult: unknown = JSON.parse(await readFile(restartResultFile, "utf-8"));
    assert(isRecord(restartResult), "Fresh-process restart result is invalid");
    assert(restartResult.status === "passed", "Fresh-process restart child did not pass");

    console.log(
      JSON.stringify(
        {
          calibration,
          checkpoints: ids,
          estimatorEvidence,
          midTurn: scenario === "mid-turn",
          model: `openai-codex/${modelId}`,
          postCompactionToolCalls,
          realWindow: usesRealWindow(scenario),
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
        2,
      ),
    );
  } finally {
    await disposeCanarySession(session, transportMode);
  }
};

if (process.argv[1] === import.meta.filename) {
  try {
    const invocation = parseLiveInvocation(process.argv.slice(2), process.env);
    await (invocation.process === "child" ? runFreshChild(invocation) : main(invocation));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
