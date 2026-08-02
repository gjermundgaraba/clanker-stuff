/* oxlint-disable eslint/no-await-in-loop, eslint/complexity, promise/avoid-new -- eval variants stay sequential for timing isolation; metrics collect both Pi and native Codex event shapes */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type {
  Api,
  AssistantMessage,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
const DEFAULT_THINKING = "high";
const TASK_ID = "inventory-planner-v1";
const TASK_PROMPT = `Implement the inventory planner described in SPEC.md.

Inspect the existing source and tests, make the minimum correct changes, and run the tests. Do not modify SPEC.md or existing tests. Do not add dependencies or commit changes.`;
const TOOLS_EXTENSION_PATH = fileURLToPath(
  new URL("../index.ts", import.meta.url)
);
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const isThinkingLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

const SPEC = `# Inventory planner

Implement the three exported functions in \`src/\`.

## \`parseEvents(input)\`

The input is newline-delimited JSON.

- Ignore blank lines and lines whose first non-whitespace character is \`#\`.
- Report malformed JSON with a \`SyntaxError\` whose message starts with \`line N:\`, using the physical input line number.
- Each event must be an object with:
  - \`type\`: \`receive\`, \`ship\`, or \`adjust\`
  - \`sku\`: a non-empty string, normalized with \`trim().toUpperCase()\`
  - \`quantity\`: a positive integer for \`receive\` and \`ship\`, or a non-negative integer for \`adjust\`
- Invalid events throw a \`TypeError\` whose message starts with \`line N:\`.
- Return normalized events shaped as \`{ type, sku, quantity, line }\`.

## \`applyEvents(events)\`

Return a \`Map\` from normalized SKU to current quantity. Missing SKUs start at zero.

- \`receive\` adds quantity.
- \`ship\` subtracts quantity.
- \`adjust\` sets the absolute quantity.
- Shipping below zero throws a \`RangeError\` mentioning both the SKU and event line.

## \`buildReorderPlan(input, policies)\`

\`policies\` is an object keyed by SKU. Each value has non-negative integer
\`target\` and \`unitPriceCents\` fields. Normalize policy SKU keys like event
SKUs and reject invalid policies with \`TypeError\`.

Return:

\`\`\`js
{
  items: [{
    sku,
    current,
    target,
    orderQuantity,
    estimatedCostCents
  }],
  totalCostCents
}
\`\`\`

Include only SKUs below target. Sort by \`estimatedCostCents\` descending, then
by SKU ascending. All monetary arithmetic is integer cents.
`;

const EVENTS_SOURCE = `export function parseEvents(input) {
  return input
    .trim()
    .split("\\n")
    .map((line, index) => ({ ...JSON.parse(line), line: index + 1 }));
}
`;

const INVENTORY_SOURCE = `export function applyEvents(events) {
  const stock = new Map();

  for (const event of events) {
    const current = stock.get(event.sku) ?? 0;
    stock.set(
      event.sku,
      event.type === "receive"
        ? current + event.quantity
        : current - event.quantity
    );
  }

  return stock;
}
`;

const REORDER_SOURCE = `import { parseEvents } from "./events.js";
import { applyEvents } from "./inventory.js";

export function buildReorderPlan(input, policies) {
  const stock = applyEvents(parseEvents(input));
  const items = Object.entries(policies)
    .map(([sku, policy]) => {
      const current = stock.get(sku) ?? 0;
      const orderQuantity = Math.max(0, policy.target - current);
      return {
        sku,
        current,
        target: policy.target,
        orderQuantity,
        estimatedCostCents: orderQuantity * policy.unitPriceCents,
      };
    })
    .filter((item) => item.orderQuantity > 0)
    .sort((left, right) => left.sku.localeCompare(right.sku));

  return {
    items,
    totalCostCents: items.reduce(
      (total, item) => total + item.estimatedCostCents,
      0
    ),
  };
}
`;

const PUBLIC_TEST = `import assert from "node:assert/strict";
import test from "node:test";

import { parseEvents } from "../src/events.js";
import { applyEvents } from "../src/inventory.js";
import { buildReorderPlan } from "../src/reorder.js";

test("parses comments, blank lines, and normalized events", () => {
  const events = parseEvents(\`# opening stock
{"type":"receive","sku":" widget ","quantity":5}

{"type":"adjust","sku":"gadget","quantity":0}\`);

  assert.deepEqual(events, [
    { type: "receive", sku: "WIDGET", quantity: 5, line: 2 },
    { type: "adjust", sku: "GADGET", quantity: 0, line: 4 },
  ]);
});

test("reports the physical line for malformed JSON", () => {
  assert.throws(
    () => parseEvents(\`# comment

{"type":"receive"\`),
    { message: /^line 3:/ }
  );
});

test("rejects invalid event fields", () => {
  assert.throws(
    () => parseEvents('{"type":"ship","sku":"x","quantity":0}'),
    { name: "TypeError", message: /^line 1:/ }
  );
});

test("applies receive, ship, and adjust events", () => {
  const stock = applyEvents([
    { type: "receive", sku: "A", quantity: 8, line: 1 },
    { type: "ship", sku: "A", quantity: 3, line: 2 },
    { type: "adjust", sku: "B", quantity: 4, line: 3 },
  ]);

  assert.deepEqual([...stock], [
    ["A", 5],
    ["B", 4],
  ]);
});

test("rejects shipments that make stock negative", () => {
  assert.throws(
    () =>
      applyEvents([{ type: "ship", sku: "WIDGET", quantity: 1, line: 7 }]),
    { name: "RangeError", message: /WIDGET.*7|7.*WIDGET/ }
  );
});

test("builds and sorts a reorder plan", () => {
  const result = buildReorderPlan(
    '{"type":"receive","sku":" a ","quantity":2}\\n' +
      '{"type":"receive","sku":"B","quantity":1}',
    {
      a: { target: 5, unitPriceCents: 100 },
      B: { target: 4, unitPriceCents: 250 },
      C: { target: 0, unitPriceCents: 999 },
    }
  );

  assert.deepEqual(result, {
    items: [
      {
        sku: "B",
        current: 1,
        target: 4,
        orderQuantity: 3,
        estimatedCostCents: 750,
      },
      {
        sku: "A",
        current: 2,
        target: 5,
        orderQuantity: 3,
        estimatedCostCents: 300,
      },
    ],
    totalCostCents: 1050,
  });
});
`;

const HIDDEN_TEST = `import assert from "node:assert/strict";
import test from "node:test";

import { parseEvents } from "../src/events.js";
import { applyEvents } from "../src/inventory.js";
import { buildReorderPlan } from "../src/reorder.js";

test("empty and comment-only input has no events", () => {
  assert.deepEqual(parseEvents("  \\n  # one\\n\\t# two\\n"), []);
});

test("validates event objects, SKUs, types, and quantities", () => {
  for (const input of [
    "null",
    '{"type":"receive","sku":" ","quantity":1}',
    '{"type":"remove","sku":"A","quantity":1}',
    '{"type":"receive","sku":"A","quantity":1.5}',
    '{"type":"adjust","sku":"A","quantity":-1}',
  ]) {
    assert.throws(() => parseEvents(input), {
      name: "TypeError",
      message: /^line 1:/,
    });
  }
});

test("adjust replaces stock before later events", () => {
  const events = parseEvents(
    '{"type":"receive","sku":"a","quantity":9}\\n' +
      '{"type":"adjust","sku":"A","quantity":2}\\n' +
      '{"type":"receive","sku":"a","quantity":3}'
  );
  assert.equal(applyEvents(events).get("A"), 5);
});

test("normalizes policy keys and breaks equal-cost ties by SKU", () => {
  assert.deepEqual(
    buildReorderPlan("", {
      " z ": { target: 2, unitPriceCents: 50 },
      a: { target: 1, unitPriceCents: 100 },
    }).items.map((item) => item.sku),
    ["A", "Z"]
  );
});

test("rejects malformed policies", () => {
  for (const policies of [
    { A: null },
    { A: { target: -1, unitPriceCents: 10 } },
    { A: { target: 1.2, unitPriceCents: 10 } },
    { A: { target: 1, unitPriceCents: -1 } },
  ]) {
    assert.throws(() => buildReorderPlan("", policies), TypeError);
  }
});
`;

const FIXTURE_FILES = {
  "SPEC.md": SPEC,
  "package.json": `${JSON.stringify(
    {
      name: "inventory-planner-eval",
      private: true,
      scripts: { test: "node --test" },
      type: "module",
    },
    null,
    2
  )}\n`,
  "src/events.js": EVENTS_SOURCE,
  "src/inventory.js": INVENTORY_SOURCE,
  "src/reorder.js": REORDER_SOURCE,
  "test/inventory.test.js": PUBLIC_TEST,
} as const;
const PROTECTED_FILES = ["SPEC.md", "test/inventory.test.js"] as const;

const MODES = ["native", "direct", "code"] as const;
type Mode = (typeof MODES)[number];

interface Evaluation {
  fail: number;
  output: string;
  pass: number;
  passed: boolean;
  protectedFilesIntact: boolean;
  tests: number;
}

interface Metrics {
  assistantTurns: number;
  costUsd: number;
  elapsedMs: number;
  firstResponseMs: number | null;
  stopReasons: string[];
  toolCalls: number;
  toolNames: Record<string, number>;
  usage: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    reasoning: number;
    totalTokens: number;
  };
}

interface VariantResult {
  activeTools: string[];
  error?: string;
  evaluation: Evaluation;
  metrics: Metrics;
  mode: Mode;
  trial: number;
  workspace: string;
}

interface NativeExecEvent {
  item?: {
    id?: string;
    text?: string;
    type?: string;
  };
  message?: string;
  type?: string;
  usage?: {
    cache_write_input_tokens?: number;
    cached_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

const parseCount = (output: string, name: string) =>
  Number(new RegExp(`^(?:#|ℹ) ${name} (\\d+)$`, "mu").exec(output)?.[1] ?? 0);

const command = (
  executable: string,
  args: string[],
  cwd: string,
  timeout = 30_000
) => {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf-8",
    timeout,
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
};

const requireCommand = (executable: string, args: string[], cwd: string) => {
  const result = command(executable, args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed:\n${result.output.trim()}`
    );
  }
};

const createFixture = (cwd: string) => {
  mkdirSync(cwd, { recursive: true });
  for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(cwd, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  requireCommand("git", ["init", "--quiet"], cwd);
  requireCommand("git", ["add", "."], cwd);
  requireCommand(
    "git",
    [
      "-c",
      "user.name=Code Mode Eval",
      "-c",
      "user.email=eval@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    cwd
  );
};

const evaluate = (cwd: string): Evaluation => {
  const protectedFilesIntact = PROTECTED_FILES.every(
    (relativePath) =>
      readFileSync(path.join(cwd, relativePath), "utf-8") ===
      FIXTURE_FILES[relativePath]
  );
  const hiddenPath = path.join(cwd, "test/eval-hidden.test.js");
  writeFileSync(hiddenPath, HIDDEN_TEST);
  const result = command(process.execPath, ["--test"], cwd, 60_000);
  rmSync(hiddenPath, { force: true });
  const tests = parseCount(result.output, "tests");
  const pass = parseCount(result.output, "pass");
  const fail = parseCount(result.output, "fail");
  return {
    fail,
    output: result.output,
    pass,
    passed: result.status === 0 && protectedFilesIntact,
    protectedFilesIntact,
    tests,
  };
};

const emptyMetrics = (): Metrics => ({
  assistantTurns: 0,
  costUsd: 0,
  elapsedMs: 0,
  firstResponseMs: null,
  stopReasons: [],
  toolCalls: 0,
  toolNames: {},
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    totalTokens: 0,
  },
});

const addUsage = (metrics: Metrics, usage: Usage) => {
  metrics.usage.input += usage.input;
  metrics.usage.output += usage.output;
  metrics.usage.cacheRead += usage.cacheRead;
  metrics.usage.cacheWrite += usage.cacheWrite;
  metrics.usage.reasoning += usage.reasoning ?? 0;
  metrics.usage.totalTokens += usage.totalTokens;
  metrics.costUsd += usage.cost.total;
};

const collectMetrics = (
  messages: readonly unknown[],
  elapsedMs: number,
  firstResponseMs: number | null
): Metrics => {
  const metrics = emptyMetrics();
  metrics.elapsedMs = elapsedMs;
  metrics.firstResponseMs = firstResponseMs;
  const assistants = messages.filter(
    (message): message is AssistantMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
  );
  metrics.assistantTurns = assistants.length;

  for (const message of assistants) {
    addUsage(metrics, message.usage);
    metrics.stopReasons.push(message.stopReason);
    for (const content of message.content) {
      if (content.type !== "toolCall") {
        continue;
      }
      metrics.toolCalls += 1;
      metrics.toolNames[content.name] =
        (metrics.toolNames[content.name] ?? 0) + 1;
    }
  }
  return metrics;
};

const finalText = (messages: readonly unknown[]) => {
  const assistant = messages.findLast(
    (message): message is AssistantMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
  );
  return (
    assistant?.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n") ?? ""
  );
};

const parseNativeEvent = (line: string): NativeExecEvent | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

const nativeMetrics = (
  events: NativeExecEvent[],
  elapsedMs: number,
  firstResponseMs: number | null,
  model: Model<Api>
): Metrics => {
  const metrics = emptyMetrics();
  metrics.elapsedMs = elapsedMs;
  metrics.firstResponseMs = firstResponseMs;
  const completion = events.findLast(
    (event) => event.type === "turn.completed"
  );
  const usage = completion?.usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cached_input_tokens ?? 0;
  const cacheWrite = usage?.cache_write_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
  metrics.usage = {
    cacheRead,
    cacheWrite,
    input,
    output,
    reasoning: usage?.reasoning_output_tokens ?? 0,
    totalTokens: inputTokens + output,
  };
  metrics.costUsd =
    (input * model.cost.input +
      cacheRead * model.cost.cacheRead +
      cacheWrite * model.cost.cacheWrite +
      output * model.cost.output) /
    1_000_000;
  const toolTypes = new Set([
    "collab_tool_call",
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
  ]);
  const completedIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      metrics.assistantTurns += 1;
    }
    const itemType = event.item?.type;
    const itemId = event.item?.id;
    if (
      event.type !== "item.completed" ||
      itemType === undefined ||
      itemId === undefined ||
      !toolTypes.has(itemType) ||
      completedIds.has(itemId)
    ) {
      continue;
    }
    completedIds.add(itemId);
    metrics.toolCalls += 1;
    metrics.toolNames[itemType] = (metrics.toolNames[itemType] ?? 0) + 1;
  }
  let stopReason = "unknown";
  if (completion) {
    stopReason = "stop";
  } else if (events.some((event) => event.type === "turn.failed")) {
    stopReason = "error";
  }
  metrics.stopReasons.push(stopReason);
  return metrics;
};

const runNativeVariant = async (
  trial: number,
  cwd: string,
  model: Model<Api>,
  thinking: ThinkingLevel,
  timeoutMs: number
): Promise<VariantResult> => {
  createFixture(cwd);
  const sourceCodexHome =
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const authPath = path.join(sourceCodexHome, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(`Native Codex auth not found: ${authPath}`);
  }
  const nativeCodexHome = mkdtempSync(
    path.join(tmpdir(), "code-mode-eval-codex-home-")
  );
  chmodSync(nativeCodexHome, 0o700);
  try {
    const modelsCachePath = path.join(sourceCodexHome, "models_cache.json");
    if (existsSync(modelsCachePath)) {
      copyFileSync(
        modelsCachePath,
        path.join(nativeCodexHome, "models_cache.json")
      );
    }
    copyFileSync(authPath, path.join(nativeCodexHome, "auth.json"));
    chmodSync(path.join(nativeCodexHome, "auth.json"), 0o600);
  } catch (error) {
    rmSync(nativeCodexHome, { force: true, recursive: true });
    throw error;
  }
  const startedAt = Date.now();
  let firstResponseMs: number | null = null;
  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  const events: NativeExecEvent[] = [];
  let errorMessage: string | undefined;
  const nativeThinking = thinking === "off" ? "minimal" : thinking;
  const child = spawn(
    "codex",
    [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--model",
      model.id,
      "--config",
      `model_reasoning_effort="${nativeThinking}"`,
      "--config",
      'approval_policy="never"',
      "--cd",
      cwd,
      "-",
    ],
    {
      cwd,
      env: { ...process.env, CODEX_HOME: nativeCodexHome },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  child.stdin.end(TASK_PROMPT);
  const consumeLines = (chunk: string, flush = false) => {
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseNativeEvent(line);
      if (!event) {
        continue;
      }
      events.push(event);
      if (
        firstResponseMs === null &&
        (event.type === "item.started" || event.type === "item.completed")
      ) {
        firstResponseMs = Date.now() - startedAt;
      }
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    consumeLines(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  let forceKill: NodeJS.Timeout | undefined;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      resolve(code);
    });
  }).catch((error: unknown) => {
    errorMessage = error instanceof Error ? error.message : String(error);
    return null;
  });
  rmSync(nativeCodexHome, { force: true, recursive: true });
  consumeLines("", true);
  const elapsedMs = Date.now() - startedAt;
  if (timedOut) {
    errorMessage = `Timed out after ${timeoutMs} ms`;
  } else if (exitCode !== 0 && errorMessage === undefined) {
    errorMessage =
      events.findLast((event) => event.type === "error")?.message ??
      stderr.trim() ??
      `codex exec exited with code ${exitCode ?? "unknown"}`;
  }

  const evaluation = evaluate(cwd);
  const diff = command("git", ["diff", "--no-ext-diff", "HEAD"], cwd).output;
  const final = events.findLast(
    (event) =>
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
  )?.item?.text;
  writeFileSync(path.join(cwd, "result.patch"), diff);
  writeFileSync(path.join(cwd, "assistant.txt"), final ?? "");
  writeFileSync(path.join(cwd, "native-events.jsonl"), stdout);
  writeFileSync(path.join(cwd, "native-stderr.txt"), stderr);
  writeFileSync(path.join(cwd, "test-output.txt"), evaluation.output);
  return {
    activeTools: ["native-codex-code-mode"],
    ...(errorMessage !== undefined && errorMessage.length > 0
      ? { error: errorMessage }
      : {}),
    evaluation,
    metrics: nativeMetrics(events, elapsedMs, firstResponseMs, model),
    mode: "native",
    trial,
    workspace: cwd,
  };
};

const runPiVariant = async (
  trial: number,
  mode: "code" | "direct",
  cwd: string,
  modelRuntime: ModelRuntime,
  modelName: string,
  thinking: ThinkingLevel,
  timeoutMs: number
): Promise<VariantResult> => {
  createFixture(cwd);
  const metrics = emptyMetrics();
  const activeTools: string[] = [];
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  let errorMessage: string | undefined;
  let messages: readonly unknown[] = [];
  let firstResponseMs: number | null = null;

  try {
    const separator = modelName.indexOf("/");
    const provider = modelName.slice(0, separator);
    const id = modelName.slice(separator + 1);
    const model = modelRuntime.getModel(provider, id);
    if (!model) {
      throw new Error(`Model not found: ${modelName}`);
    }

    const agentDir = path.join(cwd, ".pi-eval-agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      additionalExtensionPaths: [TOOLS_EXTENSION_PATH],
      agentDir,
      cwd,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
    });
    await resourceLoader.reload();
    const extensionErrors = resourceLoader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      throw new Error(
        `Extension load failed: ${JSON.stringify(extensionErrors)}`
      );
    }

    const created = await createAgentSession({
      agentDir,
      cwd,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      thinkingLevel: thinking,
    });
    ({ session } = created);
    await session.bindExtensions({});
    if (mode === "code") {
      await session.prompt("/code-mode");
    }
    activeTools.push(...session.agent.state.tools.map((tool) => tool.name));
    const expectedTools =
      mode === "code"
        ? ["exec", "wait"]
        : ["exec_command", "write_stdin", "apply_patch", "view_image"];
    if (expectedTools.some((name) => !activeTools.includes(name))) {
      throw new Error(
        `${mode} mode has unexpected tools: ${activeTools.join(", ")}`
      );
    }

    let startedAt = 0;
    const unsubscribe = session.subscribe((event) => {
      if (
        startedAt > 0 &&
        firstResponseMs === null &&
        event.type === "message_update"
      ) {
        firstResponseMs = Date.now() - startedAt;
      }
    });
    startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.prompt(TASK_PROMPT),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (promptError) {
      await session.abort();
      throw promptError;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      metrics.elapsedMs = Date.now() - startedAt;
    }
    ({ messages } = session);
    Object.assign(
      metrics,
      collectMetrics(messages, metrics.elapsedMs, firstResponseMs)
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    if (session) {
      ({ messages } = session);
      Object.assign(
        metrics,
        collectMetrics(messages, metrics.elapsedMs, firstResponseMs)
      );
    }
  } finally {
    if (session) {
      try {
        await session.extensionRunner.emit({
          reason: "quit",
          type: "session_shutdown",
        });
      } finally {
        session.dispose();
      }
    }
  }

  const evaluation = evaluate(cwd);
  const diff = command("git", ["diff", "--no-ext-diff", "HEAD"], cwd).output;
  writeFileSync(path.join(cwd, "result.patch"), diff);
  writeFileSync(path.join(cwd, "assistant.txt"), finalText(messages));
  writeFileSync(path.join(cwd, "test-output.txt"), evaluation.output);
  return {
    activeTools,
    ...(errorMessage !== undefined && errorMessage.length > 0
      ? { error: errorMessage }
      : {}),
    evaluation,
    metrics,
    mode,
    trial,
    workspace: cwd,
  };
};

const average = (values: number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length;

const percent = (codeValue: number, directValue: number) =>
  directValue === 0 ? null : ((codeValue - directValue) / directValue) * 100;

const summarize = (results: VariantResult[]) => {
  const byMode = (mode: Mode) =>
    results.filter((result) => result.mode === mode);
  const summary = Object.fromEntries(
    MODES.map((mode) => {
      const variants = byMode(mode);
      return [
        mode,
        {
          averageCostUsd: average(
            variants.map((result) => result.metrics.costUsd)
          ),
          averageElapsedMs: average(
            variants.map((result) => result.metrics.elapsedMs)
          ),
          averageOutputTokens: average(
            variants.map((result) => result.metrics.usage.output)
          ),
          averageTotalTokens: average(
            variants.map((result) => result.metrics.usage.totalTokens)
          ),
          passRate:
            variants.filter((result) => result.evaluation.passed).length /
            variants.length,
        },
      ];
    })
  );
  const { code, direct, native } = summary;
  return {
    byMode: summary,
    codeModeDeltaPercent: {
      cost: percent(code.averageCostUsd, direct.averageCostUsd),
      elapsed: percent(code.averageElapsedMs, direct.averageElapsedMs),
      outputTokens: percent(
        code.averageOutputTokens,
        direct.averageOutputTokens
      ),
      totalTokens: percent(code.averageTotalTokens, direct.averageTotalTokens),
    },
    nativeCodexDeltaPercent: {
      cost: percent(native.averageCostUsd, direct.averageCostUsd),
      elapsed: percent(native.averageElapsedMs, direct.averageElapsedMs),
      outputTokens: percent(
        native.averageOutputTokens,
        direct.averageOutputTokens
      ),
      totalTokens: percent(
        native.averageTotalTokens,
        direct.averageTotalTokens
      ),
    },
  };
};

const help = () => {
  console.log(`Usage: pnpm eval:code-mode [options]

Options:
  --model <provider/id>   Model for all variants (default: ${DEFAULT_MODEL})
  --thinking <level>     Thinking level (default: ${DEFAULT_THINKING})
  --runs <n>             Three-way trials; order rotates (default: 1)
  --timeout-minutes <n>  Per-session timeout (default: 15)
  --output <directory>   Preserve workspaces and results here
  --prepare-only         Create untouched fixtures without model calls
  --help                 Show this help

Use 3 runs to balance execution order across all variants.`);
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      model: { default: DEFAULT_MODEL, type: "string" },
      output: { type: "string" },
      "prepare-only": { type: "boolean" },
      runs: { default: "1", type: "string" },
      thinking: { default: DEFAULT_THINKING, type: "string" },
      "timeout-minutes": { default: "15", type: "string" },
    },
    strict: true,
  });
  if (values.help === true) {
    help();
    return;
  }

  const modelName = values.model;
  if (!modelName.includes("/")) {
    throw new Error("--model must be provider/id");
  }
  const { thinking } = values;
  if (!isThinkingLevel(thinking)) {
    throw new Error(`Invalid thinking level: ${thinking}`);
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error("--runs must be an integer from 1 to 10");
  }
  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be positive");
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const requestedOutput = path.resolve(
    values.output ?? path.join(tmpdir(), `code-mode-eval-${timestamp}`)
  );
  if (existsSync(requestedOutput)) {
    throw new Error(`Output directory already exists: ${requestedOutput}`);
  }
  mkdirSync(requestedOutput, { recursive: true });
  const output = realpathSync(requestedOutput);

  if (values["prepare-only"] === true) {
    createFixture(path.join(output, "direct"));
    createFixture(path.join(output, "code"));
    createFixture(path.join(output, "native"));
    console.log(`Prepared comparison fixtures: ${output}`);
    return;
  }

  const modelRuntime = await ModelRuntime.create();
  const separator = modelName.indexOf("/");
  const provider = modelName.slice(0, separator);
  const id = modelName.slice(separator + 1);
  const model = modelRuntime.getModel(provider, id);
  if (!model) {
    throw new Error(`Model not found: ${modelName}`);
  }
  const results: VariantResult[] = [];
  for (let trial = 1; trial <= runs; trial += 1) {
    const offset = (trial - 1) % MODES.length;
    const modes = [...MODES.slice(offset), ...MODES.slice(0, offset)];
    for (const mode of modes) {
      console.log(`\n[${trial}/${runs}] Running ${mode} mode...`);
      results.push(
        mode === "native"
          ? await runNativeVariant(
              trial,
              path.join(
                output,
                `trial-${String(trial).padStart(2, "0")}`,
                mode
              ),
              model,
              thinking,
              timeoutMinutes * 60_000
            )
          : await runPiVariant(
              trial,
              mode,
              path.join(
                output,
                `trial-${String(trial).padStart(2, "0")}`,
                mode
              ),
              modelRuntime,
              modelName,
              thinking,
              timeoutMinutes * 60_000
            )
      );
    }
  }

  const comparison = summarize(results);
  const report = {
    comparison,
    model: modelName,
    results,
    runs,
    task: TASK_ID,
    thinking,
  };
  writeFileSync(
    path.join(output, "results.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.table(
    results.map((result) => ({
      costUsd: result.metrics.costUsd.toFixed(4),
      elapsedSec: (result.metrics.elapsedMs / 1000).toFixed(1),
      mode: result.mode,
      passed: result.evaluation.passed,
      tests: `${result.evaluation.pass}/${result.evaluation.tests}`,
      tokens: result.metrics.usage.totalTokens,
      toolCalls: result.metrics.toolCalls,
      trial: result.trial,
    }))
  );
  console.log("\nCode Mode delta (negative is lower/faster):");
  console.log(comparison.codeModeDeltaPercent);
  console.log("\nNative Codex delta vs Pi direct:");
  console.log(comparison.nativeCodexDeltaPercent);
  console.log(`\nFull results: ${path.join(output, "results.json")}`);
};

await main();
