#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../../../..");
const providerExtension = path.resolve(packageRoot, "../codex-provider/index.ts");
const subagentsExtension = path.resolve(packageRoot, "index.ts");

interface Scenario {
  delegation: "explicit" | "proactive";
  id: string;
  prompt: string;
  validate: (trace: EvaluationTrace) => string[];
}

interface ToolAttempt {
  args: ToolArguments;
  error?: boolean;
  name: string;
  sequence: number;
  toolCallId: string;
}

interface EvaluationTrace {
  finalText: string;
  tools: readonly ToolAttempt[];
}

const ToolArgumentsSchema = Type.Object(
  {
    message: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    task_name: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type ToolArguments = Static<typeof ToolArgumentsSchema>;
const ToolStartEventSchema = Type.Object(
  {
    args: Type.Unknown(),
    toolCallId: Type.String(),
    toolName: Type.String(),
    type: Type.Literal("tool_execution_start"),
  },
  { additionalProperties: true },
);
const ToolEndEventSchema = Type.Object(
  {
    isError: Type.Optional(Type.Boolean()),
    toolCallId: Type.String(),
    type: Type.Literal("tool_execution_end"),
  },
  { additionalProperties: true },
);
const AssistantMessageSchema = Type.Object(
  {
    content: Type.Array(Type.Unknown()),
    role: Type.Literal("assistant"),
  },
  { additionalProperties: true },
);
const MessageEndEventSchema = Type.Object(
  {
    message: Type.Unknown(),
    type: Type.Literal("message_end"),
  },
  { additionalProperties: true },
);
const TextContentSchema = Type.Object(
  {
    text: Type.String(),
    type: Type.Literal("text"),
  },
  { additionalProperties: true },
);
type AssistantMessage = Static<typeof AssistantMessageSchema>;

const attempts = (trace: EvaluationTrace, name: string) =>
  trace.tools.filter((call) => call.name === name);

const successful = (trace: EvaluationTrace, name: string) =>
  attempts(trace, name).filter((call) => call.error === false);

const finalTextFromMessage = (message: AssistantMessage): string =>
  message.content
    .filter((item) => Value.Check(TextContentSchema, item))
    .map((item) => item.text)
    .join("")
    .trim();

const requireMarker = (trace: EvaluationTrace, marker: string, failures: string[]): void => {
  if (!trace.finalText.endsWith(marker)) {
    failures.push(`final response must end with ${marker}`);
  }
};

const validateQueueMessages = (
  trace: EvaluationTrace,
  sends: readonly ToolAttempt[],
  failures: string[],
): void => {
  const targets = sends.flatMap((call) =>
    call.args.target === undefined ? [] : [call.args.target],
  );
  const relativeTargets = new Set(targets.map((target) => target.split("/").at(-1)));
  if (
    sends.length !== 2 ||
    relativeTargets.size !== 2 ||
    !relativeTargets.has("v1_review") ||
    !relativeTargets.has("v2_review")
  ) {
    failures.push("expected one successful queue-only message per agent");
  }
  if (attempts(trace, "send_message").some((call) => call.error !== false)) {
    failures.push("queue-only addressing included a failed message");
  }
  for (const send of sends) {
    const target = send.args.target?.split("/").at(-1);
    const expectedOther = target === "v1_review" ? "v2_review" : "v1_review";
    if (send.args.message === undefined || !send.args.message.includes(expectedOther)) {
      failures.push(`message to ${target ?? "unknown target"} did not name ${expectedOther}`);
    }
  }
};

const scenarios: readonly Scenario[] = [
  {
    delegation: "explicit",
    id: "explicit-non-delegation",
    prompt:
      "Compare the responsibilities of pi/extensions/experimental/subagents/config.ts and runtime.ts. Do not edit files. Give a concise synthesis ending with exactly EXPLICIT_DONE.",
    validate: (trace) => {
      const failures: string[] = [];
      if (attempts(trace, "spawn_agent").length > 0) {
        failures.push("explicit mode attempted delegation without an explicit request");
      }
      requireMarker(trace, "EXPLICIT_DONE", failures);
      return failures;
    },
  },
  {
    delegation: "proactive",
    id: "proactive-parallelism",
    prompt:
      "Compare the responsibilities of the V1 and V2 implementations under pi/extensions/experimental/subagents. Do not edit files. Work efficiently, give a concise synthesis, and end with exactly PROACTIVE_DONE.",
    validate: (trace) => {
      const failures: string[] = [];
      const spawnAttempts = attempts(trace, "spawn_agent");
      const spawns = successful(trace, "spawn_agent");
      if (spawnAttempts.some((call) => call.error !== false)) {
        failures.push("delegation included a failed or unfinished spawn_agent");
      }
      if (spawns.length < 2) {
        failures.push("expected at least two successful spawn_agent calls");
      }
      const taskNames = spawns.flatMap((call) =>
        call.args.task_name === undefined ? [] : [call.args.task_name],
      );
      if (new Set(taskNames).size !== spawns.length) {
        failures.push("spawn_agent calls must use distinct task names");
      }
      const firstWait = attempts(trace, "wait_agent")[0]?.sequence;
      if (
        firstWait !== undefined &&
        spawns.filter((call) => call.sequence < firstWait).length < 2
      ) {
        failures.push("expected both agents to be spawned before waiting");
      }
      if (attempts(trace, "wait_agent").length > spawns.length + 2) {
        failures.push("wait_agent usage suggests busy polling");
      }
      requireMarker(trace, "PROACTIVE_DONE", failures);
      return failures;
    },
  },
  {
    delegation: "explicit",
    id: "addressing-and-waiting",
    prompt:
      "Use two parallel subagents named v1_review and v2_review: one to inspect the V1 protocol and one to inspect the V2 protocol. After both are spawned, send each one a queue-only message naming the other task. Wait without busy polling, summarize both reports, and end with exactly ADDRESSING_DONE. Do not edit files.",
    validate: (trace) => {
      const failures: string[] = [];
      const spawns = successful(trace, "spawn_agent");
      if (spawns.length !== 2) {
        failures.push("expected exactly two successful spawn_agent calls");
      }
      const sends = successful(trace, "send_message");
      validateQueueMessages(trace, sends, failures);
      const lastSpawn = Math.max(...spawns.map((call) => call.sequence));
      const firstSend = Math.min(...sends.map((call) => call.sequence));
      const waits = attempts(trace, "wait_agent");
      const firstWait = Math.min(...waits.map((call) => call.sequence));
      if (sends.length > 0 && spawns.length > 0 && firstSend < lastSpawn) {
        failures.push("queue-only messages were sent before both spawns");
      }
      if (waits.length > 0 && sends.length > 0 && firstWait < firstSend) {
        failures.push("wait_agent ran before queue-only addressing completed");
      }
      if (waits.length === 0) {
        failures.push("expected at least one wait_agent call");
      } else if (waits.length > spawns.length + 2) {
        failures.push("wait_agent usage suggests busy polling");
      }
      requireMarker(trace, "ADDRESSING_DONE", failures);
      return failures;
    },
  },
];

const copyAuthentication = async (target: string): Promise<void> => {
  const source = path.join(getAgentDir(), "auth.json");
  try {
    await copyFile(source, path.join(target, "auth.json"));
  } catch (error) {
    throw new Error(`Unable to copy ${source}`, { cause: error });
  }
};

const runScenario = async (
  scenario: Scenario,
  model: string,
  reasoning: string,
  timeoutMs: number,
) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), `subagents-${scenario.id}-`));
  try {
    await copyAuthentication(agentDir);
    await writeFile(
      path.join(agentDir, "subagents.json"),
      `${JSON.stringify(
        {
          prompts: { delegation: scenario.delegation },
          protocols: { "*": "v2" },
          version: 1,
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(agentDir, "sessions"), { recursive: true });
    const args = [
      "--mode",
      "json",
      "--provider",
      "openai-codex",
      "--model",
      model,
      "--thinking",
      reasoning,
      "--session-dir",
      path.join(agentDir, "sessions"),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--extension",
      providerExtension,
      "--extension",
      subagentsExtension,
    ];
    const child = spawn("pi", args, {
      cwd: repositoryRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const tools: ToolAttempt[] = [];
    const toolsById = new Map<string, ToolAttempt>();
    let finalText = "";
    let sequence = 0;
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (Value.Check(ToolStartEventSchema, event)) {
          const attempt: ToolAttempt = {
            args: Value.Check(ToolArgumentsSchema, event.args) ? event.args : {},
            name: event.toolName,
            sequence,
            toolCallId: event.toolCallId,
          };
          sequence += 1;
          tools.push(attempt);
          toolsById.set(attempt.toolCallId, attempt);
        } else if (Value.Check(ToolEndEventSchema, event)) {
          const attempt = toolsById.get(event.toolCallId);
          if (attempt !== undefined) {
            attempt.error = event.isError === true;
          }
        } else if (
          Value.Check(MessageEndEventSchema, event) &&
          Value.Check(AssistantMessageSchema, event.message)
        ) {
          const text = finalTextFromMessage(event.message);
          if (text !== "") {
            finalText = text;
          }
        }
      } catch {
        // Pi startup diagnostics can be non-JSON and are intentionally omitted.
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(scenario.prompt);
    const result = Promise.withResolvers<number | null>();
    child.once("error", result.reject);
    child.once("close", result.resolve);
    let killTimer: NodeJS.Timeout | undefined;
    let rejectTimer: NodeJS.Timeout | undefined;
    const timedOut = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectTimer = setTimeout(() => {
          timedOut.reject(new Error(`Scenario ${scenario.id} did not exit after SIGKILL`));
        }, 1000);
      }, 5000);
    }, timeoutMs);
    let exitCode: number | null;
    try {
      exitCode = await Promise.race([result.promise, timedOut.promise]);
    } finally {
      clearTimeout(timer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (rejectTimer !== undefined) {
        clearTimeout(rejectTimer);
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    const trace = { finalText, tools };
    const failures = [
      ...(exitCode === 0 ? [] : [`pi exited ${exitCode}: ${stderr.trim()}`]),
      ...scenario.validate(trace),
    ];
    return {
      failures,
      finalText,
      id: scenario.id,
      passed: failures.length === 0,
      tools,
    };
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      list: { type: "boolean" },
      model: { default: "gpt-5.6-sol", type: "string" },
      reasoning: { default: "high", type: "string" },
      scenario: { multiple: true, type: "string" },
      "timeout-minutes": { default: "10", type: "string" },
    },
    strict: true,
  });
  if (values.list === true) {
    console.log(scenarios.map((scenario) => scenario.id).join("\n"));
    return;
  }
  const requested = new Set(values.scenario);
  const unknown = [...requested].filter((id) => !scenarios.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown scenario: ${unknown.join(", ")}`);
  }
  const selected = scenarios.filter(
    (scenario) => requested.size === 0 || requested.has(scenario.id),
  );
  if (values["dry-run"] === true) {
    console.log(
      JSON.stringify(
        selected.map(({ delegation, id, prompt }) => ({
          delegation,
          id,
          prompt,
        })),
        null,
        2,
      ),
    );
    return;
  }
  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be positive");
  }
  const results = [];
  for (const scenario of selected) {
    const result = await runScenario(
      scenario,
      values.model,
      values.reasoning,
      timeoutMinutes * 60_000,
    );
    results.push(result);
  }
  console.log(JSON.stringify({ model: values.model, results }, null, 2));
  if (results.some((result) => !result.passed)) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
