#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "index.ts");
const CHECKPOINT_TYPE = "codex-compaction.checkpoint";
const DIAGNOSTIC_TYPE = "codex-compaction.diagnostic";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const positiveInteger = (name, fallback) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  assert(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive safe integer`
  );
  return value;
};

const customEntries = (manager, customType) =>
  manager
    .getBranch()
    .filter(
      (entry) => entry.type === "custom" && entry.customType === customType
    );

const contextTokens = (usage) =>
  usage?.totalTokens ||
  (usage?.input ?? 0) +
    (usage?.output ?? 0) +
    (usage?.cacheRead ?? 0) +
    (usage?.cacheWrite ?? 0);

const responseId = (entry) => {
  const id = entry?.type === "custom" ? entry.data?.response?.id : undefined;
  assert(
    typeof id === "string" && id.length > 0,
    "Checkpoint response ID missing"
  );
  return id;
};

const assertCheckpoint = (
  entry,
  expectedRound,
  forcedContextWindow,
  minimumSideInputTokens,
  requireLocalThreshold,
  expectedPhase = "pre-sampling"
) => {
  assert(
    entry?.type === "custom",
    `Round ${expectedRound}: checkpoint missing`
  );
  const checkpoint = entry.data;
  assert(
    checkpoint?.version === 4,
    `Round ${expectedRound}: expected checkpoint v4`
  );
  assert(
    checkpoint.phase === expectedPhase && checkpoint.reason === "threshold",
    `Round ${expectedRound}: unexpected checkpoint phase/reason`
  );
  assert(Number.isSafeInteger(checkpoint.sourceTokens), "Source usage missing");
  if (requireLocalThreshold) {
    assert(
      checkpoint.sourceTokens >= Math.floor(forcedContextWindow * 0.9),
      `Round ${expectedRound}: checkpoint source did not cross 90%`
    );
  }
  assert(
    Array.isArray(checkpoint.replacement) &&
      checkpoint.replacement.filter((item) => item?.type === "compaction")
        .length === 1,
    `Round ${expectedRound}: checkpoint replacement is not canonical`
  );
  if (expectedPhase === "mid-turn") {
    assert(
      !checkpoint.replacement.some(
        (item) =>
          item?.type === "function_call" ||
          item?.type === "function_call_output"
      ),
      `Round ${expectedRound}: tool history leaked into the replacement`
    );
  }
  const usage = checkpoint.response?.usage;
  const sideInputTokens =
    (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  assert(
    Number.isSafeInteger(sideInputTokens) &&
      sideInputTokens >= minimumSideInputTokens,
    `Round ${expectedRound}: provider processed ${sideInputTokens ?? "unknown"} input tokens; expected at least ${minimumSideInputTokens}`
  );
  return sideInputTokens;
};

const lastAssistant = (session) =>
  session.messages.toReversed().find((message) => message.role === "assistant");

const syntheticHex = (bytes) =>
  randomBytes(Math.ceil(bytes / 2))
    .toString("hex")
    .slice(0, bytes);

const syntheticText = (bytes) => {
  const unit = "The quick brown fox jumps over the lazy dog. ";
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
};

const requiredEnvironment = (name) => {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
};

const runBranchChild = async () => {
  const canaryCwd = requiredEnvironment("CODEX_COMPACTION_BRANCH_CWD");
  const firstEntryId = requiredEnvironment(
    "CODEX_COMPACTION_BRANCH_FIRST_ENTRY"
  );
  const firstResponseId = requiredEnvironment(
    "CODEX_COMPACTION_BRANCH_FIRST_RESPONSE"
  );
  const isolatedAgentDir = requiredEnvironment(
    "CODEX_COMPACTION_BRANCH_AGENT_DIR"
  );
  const modelId = requiredEnvironment("CODEX_COMPACTION_BRANCH_MODEL");
  const resultFile = requiredEnvironment("CODEX_COMPACTION_BRANCH_RESULT");
  const secondEntryId = requiredEnvironment(
    "CODEX_COMPACTION_BRANCH_SECOND_ENTRY"
  );
  const secondResponseId = requiredEnvironment(
    "CODEX_COMPACTION_BRANCH_SECOND_RESPONSE"
  );
  const sessionDir = requiredEnvironment("CODEX_COMPACTION_BRANCH_SESSION_DIR");
  const sessionFile = requiredEnvironment(
    "CODEX_COMPACTION_BRANCH_SESSION_FILE"
  );
  const realAgentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(realAgentDir, "auth.json"),
    modelsPath: path.join(realAgentDir, "models.json"),
  });
  const baseModel = modelRuntime.getModel("openai-codex", modelId);
  assert(baseModel, `Model openai-codex/${modelId} is unavailable`);
  const notifications = [];

  const openSession = async (manager, contextWindow) => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      transport: "sse",
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
      systemPrompt:
        "This is a branch replay canary. Reply with one short acknowledgement and do not use tools.",
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
      uiContext: {
        notify: (message) => notifications.push(message),
        setStatus: () => null,
      },
    });
    return created.session;
  };

  let manager = SessionManager.open(sessionFile, sessionDir, canaryCwd);
  let session = await openSession(manager, 4096);
  try {
    await session.navigateTree(firstEntryId, { summarize: false });
    const activeCheckpoints = customEntries(manager, CHECKPOINT_TYPE);
    const [activeCheckpoint] = activeCheckpoints;
    assert(
      activeCheckpoints.length === 1 &&
        responseId(activeCheckpoint) === firstResponseId,
      "Checkpoint 1 was not active after the fresh-process fork"
    );
    await session.prompt(
      `FRESH PROCESS DIVERGENT BRANCH.\n${"d".repeat(20_000)}`
    );
    const divergentCheckpoints = customEntries(manager, CHECKPOINT_TYPE);
    assert(
      divergentCheckpoints.length === 2 &&
        responseId(divergentCheckpoints[0]) === firstResponseId &&
        responseId(divergentCheckpoints[1]) !== secondResponseId,
      "Divergent branch reused or retained checkpoint 2"
    );
    const [, divergentEntry] = divergentCheckpoints;
    assert(divergentEntry, "Divergent checkpoint missing");
    const divergentEntryId = divergentEntry.id;
    const divergentResponseId = responseId(divergentEntry);
    assert(
      lastAssistant(session)?.stopReason === "stop",
      "Divergent branch assistant did not complete"
    );
    session.dispose();

    manager = SessionManager.open(sessionFile, sessionDir, canaryCwd);
    session = await openSession(
      manager,
      Math.max(baseModel.contextWindow, 1_000_000)
    );
    await session.navigateTree(secondEntryId, { summarize: false });
    await session.prompt("FRESH PROCESS ORIGINAL BRANCH. Reply only ORIGINAL.");
    const originalCheckpoints = customEntries(manager, CHECKPOINT_TYPE);
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

    await session.navigateTree(divergentEntryId, { summarize: false });
    const restoredDivergent = customEntries(manager, CHECKPOINT_TYPE);
    assert(
      restoredDivergent.length === 2 &&
        responseId(restoredDivergent[1]) === divergentResponseId &&
        !restoredDivergent.some(
          (entry) => responseId(entry) === secondResponseId
        ),
      "Divergent branch was not independently restorable"
    );
    assert(
      customEntries(manager, DIAGNOSTIC_TYPE).length === 0,
      "Branch replay persisted a framing diagnostic"
    );

    await writeFile(
      resultFile,
      JSON.stringify({
        divergentResponseId,
        firstResponseId,
        notifications,
        originalResponseId: secondResponseId,
        status: "passed",
      })
    );
  } finally {
    session.dispose();
  }
};

// oxlint-disable-next-line complexity -- one linear live-canary workflow
const main = async () => {
  const branchMode = process.argv.includes("--branch");
  const midTurn = process.argv.includes("--mid-turn");
  const realWindowMode = process.argv.includes("--real-window");
  const realWindow = midTurn || realWindowMode;
  const websocketMode = process.argv.includes("--websocket");
  assert(
    [branchMode, midTurn, realWindowMode, websocketMode].filter(Boolean)
      .length <= 1,
    "Choose only one live canary mode"
  );
  if (process.argv.includes("--help")) {
    console.log(`Usage:
  pnpm --dir codex-compaction test:live
  pnpm --dir codex-compaction test:live:branch
  pnpm --dir codex-compaction test:live:real
  pnpm --dir codex-compaction test:live:mid-turn
  pnpm --dir codex-compaction test:live:websocket

Environment:
  CODEX_COMPACTION_LIVE_MODEL          Model ID (default: gpt-5.6-sol)
  CODEX_COMPACTION_LIVE_ROUNDS         Inline compactions (default: 3; real: 2; mid-turn: 1)
  CODEX_COMPACTION_LIVE_CONTEXT_WINDOW Forced estimator window (default: 4096)
  CODEX_COMPACTION_LIVE_PAYLOAD_BYTES  Synthetic bytes per round (default: 20000)
  CODEX_COMPACTION_LIVE_DIR            Parent directory for retained artifacts`);
    return;
  }

  const modelId =
    process.env.CODEX_COMPACTION_LIVE_MODEL?.trim() || "gpt-5.6-sol";
  const defaultRounds = branchMode || realWindow || websocketMode ? 2 : 3;
  const rounds = positiveInteger(
    "CODEX_COMPACTION_LIVE_ROUNDS",
    midTurn ? 1 : defaultRounds
  );
  assert(
    rounds >= (midTurn ? 1 : 2),
    `Live canary requires at least ${midTurn ? 1 : 2} compaction(s)`
  );

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
    path.join(artifactParent, "codex-compaction-live-")
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
  assert(baseModel, `Model openai-codex/${modelId} is unavailable`);
  assert(
    baseModel.api === "openai-codex-responses",
    `Model ${modelId} does not use openai-codex-responses`
  );
  assert(
    await modelRuntime.getAuth(baseModel),
    "OpenAI Codex auth is unavailable"
  );
  const forcedContextWindow = realWindow
    ? baseModel.contextWindow
    : positiveInteger("CODEX_COMPACTION_LIVE_CONTEXT_WINDOW", 4096);
  let payloadBytes = realWindow
    ? 0
    : positiveInteger("CODEX_COMPACTION_LIVE_PAYLOAD_BYTES", 20_000);
  if (!realWindow) {
    assert(
      payloadBytes >= forcedContextWindow * 0.9 * 4,
      "Synthetic payload must cross the 90% local context estimate"
    );
  }
  const minimumSideInputTokens = realWindow
    ? Math.floor(forcedContextWindow * (midTurn ? 0.8 : 0.9))
    : 0;

  const extensionErrors = [];
  const notifications = [];
  const statuses = [];
  const createCanarySession = async (
    sessionManager,
    contextWindow,
    loadCompaction = true,
    customTools = []
  ) => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      transport: websocketMode ? "websocket" : "sse",
    });
    const resourceLoader = new DefaultResourceLoader({
      additionalExtensionPaths: loadCompaction ? [EXTENSION_PATH] : [],
      agentDir: isolatedAgentDir,
      cwd: canaryCwd,
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      systemPrompt:
        customTools.length > 0
          ? "Call context_filler exactly once, then reply only MIDTURN COMPLETE. Never call the tool twice."
          : "This is a live compaction canary. Reply with one short acknowledgement and do not use tools.",
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
        "codex-compaction extension was not loaded"
      );
    }
    const toolOptions =
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
      onError: (error) => extensionErrors.push(error),
      uiContext: {
        notify: (message) => notifications.push(message),
        setStatus: (key, text) => statuses.push({ key, text }),
      },
    });
    return created.session;
  };

  let calibration;
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

  const manager = SessionManager.create(canaryCwd, sessionDir);
  let toolCalls = 0;
  const midTurnTool = {
    description:
      "Return the synthetic context payload. Call exactly once when instructed.",
    execute: async () => {
      toolCalls += 1;
      return {
        content: [
          {
            text:
              toolCalls === 1
                ? syntheticText(payloadBytes)
                : "context_filler was already called",
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
  let session = await createCanarySession(
    manager,
    forcedContextWindow,
    true,
    midTurn ? [midTurnTool] : []
  );
  const ids = [];
  const sideInputTokens = [];
  try {
    console.log(`Live artifacts: ${runRoot}`);
    console.log(
      `Running ${rounds} ${midTurn ? "mid-turn " : ""}inline compactions with openai-codex/${modelId} (${forcedContextWindow.toLocaleString()} token window)...`
    );
    for (let round = 1; round <= rounds; round += 1) {
      if (midTurn) {
        // oxlint-disable-next-line no-await-in-loop -- optional repeated mid-turn rounds are sequential
        await session.prompt(
          `Call context_filler exactly once for mid-turn canary round ${round}, then give the required final reply.`
        );
        assert(
          toolCalls === round,
          `Round ${round}: expected ${round} tool call(s), observed ${toolCalls}`
        );
      } else if (realWindow) {
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
          CHECKPOINT_TYPE
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
          customEntries(manager, CHECKPOINT_TYPE).length === checkpointsBefore,
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
      const checkpoints = customEntries(manager, CHECKPOINT_TYPE);
      if (checkpoints.length !== round) {
        throw new Error(
          `Round ${round}: expected ${round} checkpoints, found ${checkpoints.length}; assistant=${lastAssistant(session)?.stopReason ?? "missing"}; notifications=${notifications.join(" | ")}; statusUpdates=${statuses.length}`
        );
      }
      const checkpoint = checkpoints.at(-1);
      const inputTokens = assertCheckpoint(
        checkpoint,
        round,
        forcedContextWindow,
        minimumSideInputTokens,
        !realWindow || midTurn,
        midTurn ? "mid-turn" : "pre-sampling"
      );
      const id = responseId(checkpoint);
      assert(!ids.includes(id), `Round ${round}: response ID was reused`);
      ids.push(id);
      sideInputTokens.push(inputTokens);
      assert(
        lastAssistant(session)?.stopReason === "stop",
        `Round ${round}: assistant did not complete`
      );
      assert(
        customEntries(manager, DIAGNOSTIC_TYPE).length === 0,
        `Round ${round}: framing diagnostic was persisted`
      );
      console.log(
        `Round ${round}: checkpoint ${id}; provider input ${inputTokens.toLocaleString()} tokens (${((inputTokens / forcedContextWindow) * 100).toFixed(1)}%)`
      );
    }

    const sessionFile = manager.getSessionFile();
    assert(sessionFile, "Persistent session file was not created");
    if (branchMode) {
      const checkpoints = customEntries(manager, CHECKPOINT_TYPE);
      const [first, second] = checkpoints;
      assert(first && second, "Branch canary requires two checkpoints");
      const resultFile = path.join(runRoot, "branch-result.json");
      session.dispose();
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
        },
        stdio: "inherit",
      });
      const branchResult = JSON.parse(await readFile(resultFile, "utf-8"));
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
            sessionFile,
          },
          null,
          2
        )
      );
      return;
    }
    session.dispose();

    const resumedManager = SessionManager.open(
      sessionFile,
      sessionDir,
      canaryCwd
    );
    session = await createCanarySession(
      resumedManager,
      Math.max(baseModel.contextWindow, 1_000_000)
    );
    await session.prompt("LIVE CANARY RESUME. Reply only RESUMED.");
    const resumedCheckpoints = customEntries(resumedManager, CHECKPOINT_TYPE);
    assert(
      resumedCheckpoints.length === rounds,
      "Resume unexpectedly created or lost a checkpoint"
    );
    assert(
      responseId(resumedCheckpoints.at(-1)) === ids.at(-1),
      "Resume did not retain the newest checkpoint"
    );
    assert(
      customEntries(resumedManager, DIAGNOSTIC_TYPE).length === 0,
      "Resume persisted a framing diagnostic"
    );
    assert(
      lastAssistant(session)?.stopReason === "stop",
      "Resumed assistant did not complete"
    );
    assert(extensionErrors.length === 0, "Extension errors were emitted");

    console.log(
      JSON.stringify(
        {
          calibration,
          checkpoints: ids,
          midTurn,
          model: `openai-codex/${modelId}`,
          notifications,
          realWindow,
          rounds,
          sessionFile,
          sideInputTokens,
          status: "passed",
          statusUpdates: statuses.length,
          transport: websocketMode ? "websocket+sse-compaction" : "sse",
        },
        null,
        2
      )
    );
  } finally {
    session.dispose();
  }
};

try {
  await (process.argv.includes("--branch-child") ? runBranchChild() : main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
