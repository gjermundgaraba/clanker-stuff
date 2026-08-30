import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { CHECKPOINT_CUSTOM_TYPE } from "../checkpoint.ts";
import { evaluationTasks } from "../evals/tasks.ts";
import type { EvaluationTask } from "../evals/tasks.ts";
import { isWireRecord as isRecord, NumberValueSchema, StringValueSchema } from "./wire.ts";
import type { WireRecord as JsonRecord, WireValue } from "./wire.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "index.ts");
const RUNNERS = ["pi-extension", "pi-builtin", "codex-cli"] as const;
type Runner = (typeof RUNNERS)[number];

interface Metrics {
  assistantTurns: number;
  compactions: number | null;
  elapsedMs: number;
  firstResponseMs: number | null;
  toolCalls: number;
  usage: Usage;
}

interface Usage {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

interface Grade {
  compactionObserved?: boolean;
  passed: boolean;
  protectedFilesIntact: boolean;
  tests: number;
}

interface EvaluationResult {
  diff: { added: number; bytes: number; deleted: number; files: number };
  dryRun: boolean;
  error?: string;
  events: string;
  exitCodes: readonly (number | null)[];
  grade: Grade;
  metrics: Metrics;
  order: number;
  repetition: number;
  runner: Runner;
  task: string;
  timedOut: boolean;
  turns: number;
}

const errorMessage = (cause: WireValue) =>
  cause instanceof Error ? cause.message : "Unknown evaluation error";

const emptyUsage = (): Usage => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

const emptyMetrics = (compactions: number | null = 0): Metrics => ({
  assistantTurns: 0,
  compactions,
  elapsedMs: 0,
  firstResponseMs: null,
  toolCalls: 0,
  usage: emptyUsage(),
});

const number = (value: WireValue) =>
  Value.Check(NumberValueSchema, value) && Number.isFinite(value) ? value : 0;

const addUsage = (metrics: Metrics, value: WireValue, native = false) => {
  if (!isRecord(value)) {
    return;
  }
  if (native) {
    const input = number(value.input_tokens);
    const cacheRead = number(value.cached_input_tokens);
    const cacheWrite = number(value.cache_write_input_tokens);
    const output = number(value.output_tokens);
    metrics.usage.input += Math.max(0, input - cacheRead - cacheWrite);
    metrics.usage.cacheRead += cacheRead;
    metrics.usage.cacheWrite += cacheWrite;
    metrics.usage.output += output;
    metrics.usage.reasoning += number(value.reasoning_output_tokens);
    metrics.usage.total += input + output;
    return;
  }
  metrics.usage.input += number(value.input);
  metrics.usage.output += number(value.output);
  metrics.usage.cacheRead += number(value.cacheRead);
  metrics.usage.cacheWrite += number(value.cacheWrite);
  metrics.usage.reasoning += number(value.reasoning);
  metrics.usage.total +=
    number(value.totalTokens) ||
    number(value.input) + number(value.output) + number(value.cacheRead) + number(value.cacheWrite);
};

const sanitizeUsage = (value: WireValue, native: boolean): Usage => {
  const metrics = emptyMetrics();
  addUsage(metrics, value, native);
  return metrics.usage;
};

const sanitizeEvent = (
  runner: Runner,
  turn: number,
  event: JsonRecord,
  metrics: Metrics,
  startedAt: number,
): JsonRecord | undefined => {
  const type = Value.Check(StringValueSchema, event.type) ? event.type : "unknown";
  if (metrics.firstResponseMs === null && (type === "message_update" || type === "item.started")) {
    metrics.firstResponseMs = Date.now() - startedAt;
  }
  if (runner === "codex-cli") {
    const item = isRecord(event.item) ? event.item : undefined;
    if (type === "turn.completed") {
      addUsage(metrics, event.usage, true);
    }
    if (
      type === "item.completed" &&
      item &&
      ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(
        String(item.type),
      )
    ) {
      metrics.toolCalls += 1;
    }
    if (type === "item.completed" && item?.type === "agent_message") {
      metrics.assistantTurns += 1;
    }
    if (
      ![
        "thread.started",
        "turn.started",
        "turn.completed",
        "turn.failed",
        "item.started",
        "item.completed",
        "error",
      ].includes(type)
    ) {
      return undefined;
    }
    return {
      itemType: item?.type,
      runner,
      turn,
      type,
      usage: type === "turn.completed" ? sanitizeUsage(event.usage, true) : undefined,
    };
  }

  const entry = isRecord(event.entry) ? event.entry : undefined;
  const result = isRecord(event.result) ? event.result : undefined;
  const details = isRecord(result?.details) ? result.details : undefined;
  const checkpointAppended =
    type === "entry_appended" &&
    entry?.type === "custom" &&
    entry.customType === CHECKPOINT_CUSTOM_TYPE;
  const extensionCheckpoint =
    checkpointAppended || (type === "compaction_end" && details?.type === CHECKPOINT_CUSTOM_TYPE);
  if (checkpointAppended || (type === "compaction_end" && result)) {
    metrics.compactions = (metrics.compactions ?? 0) + 1;
  }
  if (type === "compaction_end") {
    addUsage(metrics, result?.usage);
  }
  if (type === "tool_execution_end") {
    metrics.toolCalls += 1;
  }
  const message = isRecord(event.message) ? event.message : undefined;
  if (type === "message_end" && message?.role === "assistant") {
    metrics.assistantTurns += 1;
    addUsage(metrics, message.usage);
  }
  if (
    !checkpointAppended &&
    ![
      "session",
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
    ].includes(type)
  ) {
    return undefined;
  }
  return {
    aborted: event.aborted,
    customType: extensionCheckpoint ? CHECKPOINT_CUSTOM_TYPE : undefined,
    isError: event.isError,
    role: message?.role,
    reason: event.reason,
    stopReason: message?.stopReason,
    toolName: event.toolName,
    usage: message?.usage === undefined ? undefined : sanitizeUsage(message.usage, false),
    runner,
    turn,
    type,
  };
};

const runJsonProcess = async (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input: string,
  timeoutMs: number,
  onEvent: (event: JsonRecord) => void,
) => {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const event: WireValue = JSON.parse(line);
      if (isRecord(event)) {
        onEvent(event);
      }
    } catch {
      // Startup warnings are intentionally not retained: they can contain local paths.
    }
  });
  child.stderr.resume();
  child.stdin.on("error", (streamError) => {
    if (!("code" in streamError) || streamError.code !== "EPIPE") {
      child.kill("SIGTERM");
    }
  });
  child.stdin.end(input);
  let forceKill: NodeJS.Timeout | undefined;
  const exit = Promise.withResolvers<number | null>();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);
  }, timeoutMs);
  child.once("error", exit.reject);
  child.once("close", (code) => {
    clearTimeout(timer);
    clearTimeout(forceKill);
    exit.resolve(code);
  });
  const exitCode = await exit.promise;
  return { exitCode, timedOut };
};

export const command = (
  executable: string,
  args: readonly string[],
  cwd: string,
  timeout = 60_000,
) =>
  spawnSync(executable, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });

export const codexArguments = (
  model: string,
  reasoning: string,
  cwd: string,
  turnIndex: number,
) => {
  const base = [
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--model",
    model,
    "--config",
    `model_reasoning_effort="${reasoning}"`,
    "--config",
    'approval_policy="never"',
    "--config",
    'sandbox_mode="workspace-write"',
  ];
  return turnIndex === 0
    ? ["exec", ...base, "--color", "never", "--cd", cwd, "-"]
    : ["exec", "resume", "--last", ...base, "-"];
};

const requireCommand = (executable: string, args: readonly string[], cwd: string) => {
  const result = command(executable, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${executable} exited ${result.status}`);
  }
};

const writeFiles = (cwd: string, files: Readonly<Record<string, string>>) => {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(cwd, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
};

const createFixture = (cwd: string, task: EvaluationTask) => {
  mkdirSync(cwd, { recursive: true });
  writeFiles(cwd, task.files);
  requireCommand("git", ["init", "--quiet"], cwd);
  requireCommand("git", ["add", "."], cwd);
  requireCommand(
    "git",
    [
      "-c",
      "user.name=Agent Evaluation",
      "-c",
      "user.email=eval@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    cwd,
  );
};

const grade = (cwd: string, task: EvaluationTask): Grade => {
  const protectedFilesIntact = task.protectedFiles.every(
    (relativePath) =>
      existsSync(path.join(cwd, relativePath)) &&
      readFileSync(path.join(cwd, relativePath), "utf-8") === task.files[relativePath],
  );
  const hiddenPath = path.join(cwd, "test/evaluation-hidden.test.js");
  mkdirSync(path.dirname(hiddenPath), { recursive: true });
  writeFileSync(hiddenPath, task.hiddenTest);
  let result: ReturnType<typeof command>;
  try {
    result = command(process.execPath, ["--test"], cwd);
  } finally {
    rmSync(hiddenPath, { force: true });
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const tests = Number(/^(?:#|ℹ) tests (?<count>\d+)$/mu.exec(output)?.groups?.count ?? 0);
  return {
    passed: result.status === 0 && protectedFilesIntact,
    protectedFilesIntact,
    tests,
  };
};

const diffMetrics = (cwd: string) => {
  requireCommand("git", ["add", "-N", "."], cwd);
  const numstatResult = command("git", ["diff", "--numstat", "HEAD"], cwd);
  if (numstatResult.status !== 0) {
    throw new Error("git diff --numstat failed");
  }
  const numstat = numstatResult.stdout;
  let added = 0;
  let deleted = 0;
  let files = 0;
  for (const line of numstat.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const [add, remove] = line.split("\t");
    added += Number(add) || 0;
    deleted += Number(remove) || 0;
    files += 1;
  }
  const diffResult = command("git", ["diff", "HEAD"], cwd);
  if (diffResult.status !== 0) {
    throw new Error("git diff failed");
  }
  return {
    added,
    bytes: Buffer.byteLength(diffResult.stdout),
    deleted,
    files,
  };
};

const failedGrade = (): Grade => ({
  passed: false,
  protectedFilesIntact: false,
  tests: 0,
});

const emptyDiff = () => ({ added: 0, bytes: 0, deleted: 0, files: 0 });

export const applyExecutionOutcome = (
  base: Grade,
  succeeded: boolean,
  compactionRequired: boolean,
  compactionObserved: boolean,
): Grade => {
  const grade: Grade = {
    ...base,
    passed: base.passed && succeeded && (!compactionRequired || compactionObserved),
  };
  if (compactionRequired) {
    grade.compactionObserved = compactionObserved;
  }
  return grade;
};

export const writeJsonReport = (target: string, report: WireValue) => {
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, target);
};

const copyAuth = (source: string, prefix: string, extra?: string) => {
  const auth = path.join(source, "auth.json");
  if (!existsSync(auth)) {
    throw new Error("Authentication file not found");
  }
  const target = mkdtempSync(path.join(tmpdir(), prefix));
  chmodSync(target, 0o700);
  copyFileSync(auth, path.join(target, "auth.json"));
  chmodSync(path.join(target, "auth.json"), 0o600);
  if (extra !== undefined && extra.length > 0 && existsSync(path.join(source, extra))) {
    copyFileSync(path.join(source, extra), path.join(target, extra));
  }
  return target;
};

const runEvaluation = async (
  runner: Runner,
  task: EvaluationTask,
  runDirectory: string,
  model: string,
  reasoning: string,
  timeoutMs: number,
  dryRun: boolean,
  repetition: number,
  order: number,
): Promise<EvaluationResult> => {
  const cwd = path.join(runDirectory, "workspace");
  const metrics = emptyMetrics(runner === "codex-cli" ? null : 0);
  const exitCodes: (number | null)[] = [];
  const sanitizedEvents: JsonRecord[] = [];
  let timedOut = false;
  let error: string | undefined;
  let fixtureReady = false;
  const { prompts } = task;
  const startedAt = Date.now();
  let privateConfig: string | undefined;

  try {
    createFixture(cwd, task);
    fixtureReady = true;
  } catch (caughtError) {
    error = `Fixture creation failed: ${errorMessage(caughtError)}`;
  }

  try {
    if (fixtureReady && dryRun) {
      writeFiles(cwd, task.solution);
    } else if (fixtureReady) {
      const isCodexCli = runner === "codex-cli";
      privateConfig = isCodexCli
        ? copyAuth(
            process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
            "codex-provider-eval-codex-",
            "models_cache.json",
          )
        : copyAuth(getAgentDir(), "codex-provider-eval-pi-");
      const executable = isCodexCli ? "codex" : "pi";
      const childEnv = isCodexCli
        ? { ...process.env, CODEX_HOME: privateConfig }
        : { ...process.env, PI_CODING_AGENT_DIR: privateConfig };
      const base = [
        "--mode",
        "json",
        "--provider",
        "openai-codex",
        "--model",
        model,
        "--thinking",
        reasoning,
        "--session-dir",
        path.join(privateConfig, "sessions"),
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        ...(runner === "pi-extension" ? ["--extension", EXTENSION_PATH] : []),
      ];
      for (const [turnIndex, prompt] of prompts.entries()) {
        const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
        const args = isCodexCli
          ? codexArguments(model, reasoning, cwd, turnIndex)
          : [...base, ...(turnIndex === 0 ? [] : ["--continue"])];
        const outcome = await runJsonProcess(
          executable,
          args,
          cwd,
          childEnv,
          prompt,
          remaining,
          (event) => {
            const sanitized = sanitizeEvent(runner, turnIndex + 1, event, metrics, startedAt);
            if (sanitized) {
              sanitizedEvents.push(sanitized);
            }
          },
        );
        exitCodes.push(outcome.exitCode);
        timedOut ||= outcome.timedOut;
        if (outcome.exitCode !== 0 || timedOut) {
          break;
        }
      }
    }
  } catch (caughtError) {
    error ??= errorMessage(caughtError);
  } finally {
    if (privateConfig !== undefined) {
      rmSync(privateConfig, { force: true, recursive: true });
    }
  }

  metrics.elapsedMs = dryRun ? 0 : Date.now() - startedAt;
  if (
    error === undefined &&
    !dryRun &&
    (timedOut || exitCodes.length !== prompts.length || exitCodes.some((code) => code !== 0))
  ) {
    error = timedOut ? `Timed out after ${timeoutMs} ms` : "Runner process failed";
  }
  const eventFile = path.join(runDirectory, "events.jsonl");
  const events = path.relative(path.resolve(runDirectory, "../../.."), eventFile);
  try {
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      eventFile,
      sanitizedEvents.map((event) => JSON.stringify(event)).join("\n") +
        (sanitizedEvents.length > 0 ? "\n" : ""),
    );
  } catch (caughtError) {
    error ??= `Event report failed: ${errorMessage(caughtError)}`;
  }
  let baseGrade = failedGrade();
  if (fixtureReady) {
    try {
      baseGrade = grade(cwd, task);
    } catch (caughtError) {
      error ??= `Grading failed: ${errorMessage(caughtError)}`;
    }
  }
  const compactionRequired =
    !dryRun && runner === "pi-extension" && task.requiresExtensionCompaction === true;
  const compactionObserved = sanitizedEvents.some(
    (event) => event.customType === CHECKPOINT_CUSTOM_TYPE,
  );
  const executionSucceeded =
    error === undefined &&
    !timedOut &&
    (dryRun || (exitCodes.length === prompts.length && exitCodes.every((code) => code === 0)));
  const evaluationGrade = applyExecutionOutcome(
    baseGrade,
    executionSucceeded,
    compactionRequired,
    compactionObserved,
  );
  if (compactionRequired && !compactionObserved && error === undefined) {
    error = "Required OpenAI checkpoint was not observed";
  }
  let diff = emptyDiff();
  if (fixtureReady) {
    try {
      diff = diffMetrics(cwd);
    } catch (caughtError) {
      error ??= `Diff collection failed: ${errorMessage(caughtError)}`;
    }
  }
  if (error !== undefined) {
    evaluationGrade.passed = false;
  }
  return {
    diff,
    dryRun,
    error,
    events,
    exitCodes,
    grade: evaluationGrade,
    metrics,
    order,
    repetition,
    runner,
    task: task.id,
    timedOut,
    turns: prompts.length,
  };
};

const runnerOrder = (repetition: number): Runner[] => {
  const offset = (repetition - 1) % RUNNERS.length;
  return [...RUNNERS.slice(offset), ...RUNNERS.slice(0, offset)];
};

const average = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const summarize = (results: readonly EvaluationResult[]) =>
  Object.fromEntries(
    RUNNERS.map((runner) => {
      const selected = results.filter((result) => result.runner === runner);
      return [
        runner,
        {
          averageElapsedMs: average(selected.map((result) => result.metrics.elapsedMs)),
          averageTotalTokens: average(selected.map((result) => result.metrics.usage.total)),
          compactions: selected.every((result) => result.metrics.compactions === null)
            ? null
            : selected.reduce((sum, result) => sum + (result.metrics.compactions ?? 0), 0),
          passRate: average(selected.map((result) => (result.grade.passed ? 1 : 0))),
          runs: selected.length,
        },
      ];
    }),
  );

const smoke = () => {
  for (const executable of ["git", "pi", "codex"]) {
    const result = command(executable, ["--version"], PACKAGE_ROOT);
    if (result.status !== 0) {
      throw new Error(`${executable} is unavailable`);
    }
  }
  const checkpointMetrics = emptyMetrics();
  const checkpointEvent = sanitizeEvent(
    "pi-extension",
    1,
    {
      entry: { customType: CHECKPOINT_CUSTOM_TYPE, type: "custom" },
      type: "entry_appended",
    },
    checkpointMetrics,
    Date.now(),
  );
  const compactionEvent = sanitizeEvent(
    "pi-extension",
    1,
    {
      result: { details: { type: CHECKPOINT_CUSTOM_TYPE } },
      type: "compaction_end",
    },
    checkpointMetrics,
    Date.now(),
  );
  sanitizeEvent(
    "pi-extension",
    1,
    { aborted: true, result: undefined, type: "compaction_end" },
    checkpointMetrics,
    Date.now(),
  );
  if (
    checkpointMetrics.compactions !== 2 ||
    checkpointEvent?.customType !== CHECKPOINT_CUSTOM_TYPE ||
    compactionEvent?.customType !== CHECKPOINT_CUSTOM_TYPE
  ) {
    throw new Error("Checkpoint event detection failed");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "codex-provider-eval-smoke-"));
  try {
    for (const task of evaluationTasks) {
      const fixture = path.join(directory, task.id);
      createFixture(fixture, task);
      if (grade(fixture, task).passed) {
        throw new Error(`${task.id}: broken fixture unexpectedly passed`);
      }
      writeFiles(fixture, task.solution);
      if (!grade(fixture, task).passed) {
        throw new Error(`${task.id}: reference solution failed`);
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
  console.log(`Smoke passed: ${evaluationTasks.length} graders and 3 runner CLIs`);
};

const help = () => {
  console.log(`Usage: vp run @clanker-stuff/codex-provider#eval:agents [options]

Options:
  --model <id>             Exact model ID for all runners (default: gpt-5.6-sol)
  --reasoning <level>      Exact reasoning level for all runners (default: high)
  --repetitions <n>        Runs per task and runner, 1-10 (default: 1)
  --timeout-minutes <n>    Timeout per task/runner (default: 20)
  --task <id>              Select a task; repeatable
  --output <directory>     New artifact directory
  --dry-run                Full matrix with reference solutions; no model calls
  --smoke                  Validate CLIs, fixtures, and graders; no model calls
  --list                   List task IDs
  --help                   Show this help`);
};

const unexpectedFailure = (
  runner: Runner,
  task: EvaluationTask,
  runDirectory: string,
  dryRun: boolean,
  repetition: number,
  order: number,
  error: WireValue,
): EvaluationResult => ({
  diff: emptyDiff(),
  dryRun,
  error: `Evaluation infrastructure failed: ${errorMessage(error)}`,
  events: path.relative(
    path.resolve(runDirectory, "../../.."),
    path.join(runDirectory, "events.jsonl"),
  ),
  exitCodes: [],
  grade: failedGrade(),
  metrics: emptyMetrics(runner === "codex-cli" ? null : 0),
  order,
  repetition,
  runner,
  task: task.id,
  timedOut: false,
  turns: task.prompts.length,
});

const main = async () => {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
      list: { type: "boolean" },
      model: { default: "gpt-5.6-sol", type: "string" },
      output: { type: "string" },
      reasoning: { default: "high", type: "string" },
      repetitions: { default: "1", type: "string" },
      smoke: { type: "boolean" },
      task: { multiple: true, type: "string" },
      "timeout-minutes": { default: "20", type: "string" },
    },
    strict: true,
  });
  if (values.help === true) {
    help();
    return;
  }
  if (values.list === true) {
    for (const task of evaluationTasks) {
      console.log(`${task.id}${task.long === true ? " (long)" : ""}`);
    }
    return;
  }
  if (values.smoke === true) {
    smoke();
    return;
  }
  if (!/^(?<level>minimal|low|medium|high|xhigh|max)$/u.test(values.reasoning)) {
    throw new Error("--reasoning must be minimal, low, medium, high, xhigh, or max");
  }
  const repetitions = Number(values.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("--repetitions must be an integer from 1 to 10");
  }
  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be positive");
  }
  const requested = new Set(values.task);
  const unknown = [...requested].filter((id) => !evaluationTasks.some((task) => task.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown task: ${unknown.join(", ")}`);
  }
  const tasks = evaluationTasks.filter((task) =>
    requested.size === 0 ? task.long !== true : requested.has(task.id),
  );
  if (tasks.length === 0) {
    throw new Error("No tasks selected");
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const requestedOutput = path.resolve(
    values.output ?? path.join(tmpdir(), `codex-provider-eval-${timestamp}`),
  );
  if (existsSync(requestedOutput)) {
    throw new Error(`Output already exists: ${requestedOutput}`);
  }
  mkdirSync(requestedOutput, { recursive: true });
  const output = realpathSync(requestedOutput);
  const results: EvaluationResult[] = [];
  const executionOrder: {
    order: readonly Runner[];
    repetition: number;
    task: string;
  }[] = [];
  const resultPath = path.join(output, "results.json");
  let reportWriteFailures = 0;
  const report = () => ({
    dryRun: values["dry-run"] === true,
    executionOrder,
    model: values.model,
    reasoning: values.reasoning,
    repetitions,
    reportWriteFailures,
    results,
    summary: summarize(results),
    tasks: tasks.map((task) => task.id),
    timeoutMinutes,
  });
  const persist = (required: boolean) => {
    try {
      writeJsonReport(resultPath, report());
    } catch (caughtError) {
      reportWriteFailures += 1;
      if (required) {
        throw caughtError;
      }
      console.error(`Results update failed: ${errorMessage(caughtError)}`);
    }
  };
  persist(true);

  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const task of tasks) {
      const order = runnerOrder(repetition);
      executionOrder.push({ order, repetition, task: task.id });
      for (const [orderIndex, runner] of order.entries()) {
        console.log(`[${task.id} ${repetition}/${repetitions}] ${runner}`);
        const runDirectory = path.join(
          output,
          `repeat-${String(repetition).padStart(2, "0")}`,
          task.id,
          runner,
        );
        try {
          results.push(
            await runEvaluation(
              runner,
              task,
              runDirectory,
              values.model,
              values.reasoning,
              timeoutMinutes * 60_000,
              values["dry-run"] === true,
              repetition,
              orderIndex + 1,
            ),
          );
        } catch (caughtError) {
          results.push(
            unexpectedFailure(
              runner,
              task,
              runDirectory,
              values["dry-run"] === true,
              repetition,
              orderIndex + 1,
              caughtError,
            ),
          );
        }
        persist(false);
      }
    }
  }

  persist(true);
  console.table(
    results.map((result) => ({
      compactions: result.metrics.compactions,
      elapsedSeconds: Math.round(result.metrics.elapsedMs / 100) / 10,
      passed: result.grade.passed,
      repetition: result.repetition,
      runner: result.runner,
      task: result.task,
      tokens: result.metrics.usage.total,
    })),
  );
  console.log(`Results: ${resultPath}`);
};

if (process.argv[1] === import.meta.filename) {
  await main();
}
