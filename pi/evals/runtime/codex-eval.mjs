#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { appendFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

const SERVER_URL = "ws://127.0.0.1:41973";

const SERVER_WAIT_MS = 10_000;

const NonEmptyStringSchema = Type.String({ minLength: 1 });

const EvalConfigSchema = Type.Object({
  compactBefore: Type.Boolean(),
  compactedAfterSegment: Type.Integer({ minimum: -1 }),
  effort: Type.Union([Type.String(), Type.Null()]),
  instructionPath: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  summary: Type.Union([Type.String(), Type.Null()]),
});

const RpcItemSchema = Type.Object({
  id: Type.Optional(NonEmptyStringSchema),
  type: Type.Optional(NonEmptyStringSchema),
});

const RpcTurnSchema = Type.Object({
  id: NonEmptyStringSchema,
  status: NonEmptyStringSchema,
});

// Unknown fields are deliberately allowed: native service hooks consume additional params,
// item and turn fields, and result/usage payloads are validated by their own consumers.
const RpcParamsSchema = Type.Object({
  item: Type.Optional(RpcItemSchema),
  responseId: Type.Optional(NonEmptyStringSchema),
  threadId: Type.Optional(NonEmptyStringSchema),
  turn: Type.Optional(RpcTurnSchema),
  turnId: Type.Optional(NonEmptyStringSchema),
  usage: Type.Optional(Type.Unknown()),
});

const RpcMessageSchema = Type.Object({
  error: Type.Optional(Type.Unknown()),
  id: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
  method: Type.Optional(NonEmptyStringSchema),
  params: Type.Optional(RpcParamsSchema),
  result: Type.Optional(Type.Unknown()),
});

const ThreadStartSchema = Type.Object({ thread: Type.Object({ id: NonEmptyStringSchema }) });

const TurnStartSchema = Type.Object({ turn: Type.Object({ id: NonEmptyStringSchema }) });

/**
 * @typedef {import("typebox").Static<typeof EvalConfigSchema>} EvalConfig
 * @typedef {import("typebox").Static<typeof RpcTurnSchema>} RpcTurn
 * @typedef {{ threadId: string, turn: RpcTurn }} TurnStart
 * @typedef {import("typebox").Static<typeof RpcParamsSchema>} RpcParams
 * @typedef {import("typebox").Static<typeof RpcMessageSchema> & {
 *   hasError: boolean,
 *   hasResult: boolean,
 * }} RpcMessage
 * @typedef {{
 *   kind: "compaction" | "ordinary",
 *   responseId: string,
 *   threadId: string,
 *   turnId: string,
 *   usage: unknown,
 * }} UsageRecord
 * @typedef {{
 *   compactedAfterSegment: number,
 *   kind: "compaction_attempt",
 *   state: "aborted" | "failed" | "succeeded",
 *   threadId: string,
 *   timestamp: string,
 *   turnId: string,
 * }} CompactionAttempt
 */

/**
 * @template {import("typebox").TSchema} Schema
 * @param {Schema} schema Expected structure.
 * @param {unknown} value Value to validate without coercion or removal of extra fields.
 * @param {string} source Human-readable source.
 * @returns {import("typebox").Static<Schema>} Validated value.
 */
const schemaValue = (schema, value, source) => {
  if (!Value.Check(schema, value)) {
    throw new TypeError(`invalid ${source}`);
  }

  return value;
};

/**
 * @param {unknown} value Value to validate.
 * @param {string} source Human-readable source.
 * @returns {string} Validated string.
 */
const stringValue = (value, source) => {
  if (!Value.Check(NonEmptyStringSchema, value)) {
    throw new TypeError(`${source} must be a non-empty string`);
  }

  return value;
};

/**
 * @param {unknown} value Parsed JSON.
 * @returns {EvalConfig} Validated runner config.
 */
export const evalConfig = (value) => {
  const config = schemaValue(
    EvalConfigSchema,
    {
      compactBefore: false,
      compactedAfterSegment: -1,
      effort: null,
      summary: null,
      ...schemaValue(Type.Object({}), value, "Codex eval config"),
    },
    "Codex eval config",
  );

  const { compactBefore, compactedAfterSegment, effort, instructionPath, model, summary } = config;

  return { compactBefore, compactedAfterSegment, effort, instructionPath, model, summary };
};

/**
 * @param {unknown} value Parsed JSON.
 * @returns {RpcMessage} Validated JSON-RPC message.
 */
export const rpcMessage = (value) => {
  const message = schemaValue(RpcMessageSchema, value, "JSON-RPC message");

  return {
    ...(message.id !== undefined ? { id: message.id } : {}),
    ...(message.method !== undefined ? { method: message.method } : {}),
    ...(message.params !== undefined ? { params: message.params } : {}),
    ...("error" in message ? { error: message.error } : {}),
    ...("result" in message ? { result: message.result } : {}),
    hasError: "error" in message,
    hasResult: "result" in message,
  };
};

/**
 * @param {unknown} result thread/start result.
 * @returns {string} Started thread id.
 */
export const startedThreadId = (result) =>
  schemaValue(ThreadStartSchema, result, "thread/start result").thread.id;

/**
 * @param {unknown} result turn/start result.
 * @returns {string} Started turn id.
 */
export const startedTurnId = (result) =>
  schemaValue(TurnStartSchema, result, "turn/start result").turn.id;

/** @param {(record: UsageRecord) => void} onRecord Persist each completed response immediately. */
export const createCapture = (onRecord = () => {}) => {
  /** @type {Map<string, { completed: boolean, expected: boolean, itemId?: string, settled?: Pick<CompactionAttempt, "state" | "timestamp"> }>} */
  const compactions = new Map();
  /** @type {UsageRecord[]} */
  const records = [];
  const responseIds = new Set();
  /** @type {Map<string, RpcTurn>} */
  const terminals = new Map();

  /**
   * @param {string} turnId Compaction turn id.
   * @param {RpcTurn} turn Terminal turn.
   */
  const settle = (turnId, turn) => {
    const compaction = compactions.get(turnId);

    if (compaction === undefined) {
      return;
    }

    if (compaction.settled !== undefined) {
      throw new Error(`duplicate terminal state for Codex compaction turn ${turnId}`);
    }

    if (!["completed", "failed", "interrupted"].includes(turn.status)) {
      throw new Error(`unknown Codex compaction status: ${turn.status}`);
    }

    /** @type {CompactionAttempt["state"]} */
    let state;

    if (compaction.completed) {
      state = "succeeded";
    } else if (turn.status === "failed") {
      state = "failed";
    } else if (turn.status === "interrupted") {
      state = "aborted";
    } else {
      throw new Error(`completed Codex compaction turn ${turnId} omitted item/completed`);
    }

    compaction.settled = { state, timestamp: new Date().toISOString() };
  };

  /** @param {string} turnId Explicit compaction turn id. */
  const beginCompaction = (turnId) => {
    const existing = compactions.get(turnId);

    if (existing?.expected) {
      throw new Error(`duplicate Codex compaction turn ${turnId}`);
    }

    const compaction = existing ?? { completed: false, expected: true };
    compaction.expected = true;
    compactions.set(turnId, compaction);
    const terminal = terminals.get(turnId);

    if (terminal !== undefined && compaction.settled === undefined) {
      settle(turnId, terminal);
    }
  };

  /** @param {RpcMessage} message JSON-RPC message. */
  const accept = (message) => {
    const { method, params } = message;

    if (method === "item/started" && params?.item?.type === "contextCompaction") {
      const turnId = stringValue(params.turnId, "compaction turn id");
      const compaction = compactions.get(turnId) ?? { completed: false, expected: false };

      if (compaction.itemId !== undefined || compaction.settled !== undefined) {
        throw new Error(`multiple Codex compaction items for turn ${turnId}`);
      }

      compaction.itemId = stringValue(params.item.id, "compaction item id");
      compactions.set(turnId, compaction);

      return;
    }

    if (method === "item/completed" && params?.item?.type === "contextCompaction") {
      const turnId = stringValue(params.turnId, "compaction turn id");
      const compaction = compactions.get(turnId);
      const itemId = stringValue(params.item.id, "compaction item id");

      if (
        compaction === undefined ||
        compaction.itemId !== itemId ||
        compaction.completed ||
        compaction.settled !== undefined
      ) {
        throw new Error(`unmatched Codex compaction completion for turn ${turnId}`);
      }

      compaction.completed = true;

      return;
    }

    if (method === "turn/completed") {
      const turn = params?.turn;

      if (turn === undefined) {
        throw new Error("turn/completed omitted its turn");
      }

      if (terminals.has(turn.id)) {
        throw new Error(`duplicate terminal Codex turn ${turn.id}`);
      }

      terminals.set(turn.id, turn);
      settle(turn.id, turn);

      return;
    }

    if (method !== "rawResponse/completed") {
      return;
    }

    const responseId = stringValue(params?.responseId, "response id");
    const threadId = stringValue(params?.threadId, "response thread id");
    const turnId = stringValue(params?.turnId, "response turn id");
    const compaction = compactions.get(turnId);
    const kind = compaction !== undefined && !compaction.completed ? "compaction" : "ordinary";

    if (responseIds.has(responseId)) {
      throw new Error(`duplicate Codex response id: ${responseId}`);
    }

    responseIds.add(responseId);

    if (params?.usage === undefined || params.usage === null) {
      if (kind === "compaction") {
        return;
      }

      throw new Error("Codex response omitted exact usage");
    }

    /** @type {UsageRecord} */
    const record = {
      kind,
      responseId,
      threadId,
      turnId,
      usage: params.usage,
    };

    records.push(record);
    onRecord(record);
  };

  const finish = () => {
    const attempts = [...compactions.entries()].map(([turnId, { settled }]) => {
      if (settled === undefined) {
        throw new Error("Codex turn ended without a terminal compaction state");
      }

      return { ...settled, turnId };
    });

    if (!records.some((record) => record.kind === "ordinary")) {
      throw new Error("Codex turn completed without an ordinary model response");
    }

    return { attempts, records };
  };

  return { accept, beginCompaction, finish };
};

/** @typedef {ReturnType<typeof createCapture>} Capture */

const openSocket = () => {
  /** @type {PromiseWithResolvers<WebSocket>} */
  const connection = Promise.withResolvers();
  const socket = new WebSocket(SERVER_URL);

  const timeout = setTimeout(() => {
    socket.close();
    connection.reject(new Error("timed out connecting to Codex app-server"));
  }, 1000);

  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    connection.resolve(socket);
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    connection.reject(new Error("Codex app-server is unavailable"));
  });

  return connection.promise;
};

/**
 * @param {number} deadline Retry deadline.
 * @returns {Promise<WebSocket | undefined>} Connected socket, if ready.
 */
const waitForSocket = async (deadline) => {
  while (Date.now() < deadline) {
    await delay(100);

    try {
      return await openSocket();
    } catch {
      // The spawned app-server may not be listening yet.
    }
  }

  return undefined;
};

const connect = async () => {
  try {
    return await openSocket();
  } catch (error) {
    const server = spawn("codex", ["app-server", "--listen", SERVER_URL], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });

    server.unref();
    const socket = await waitForSocket(Date.now() + SERVER_WAIT_MS);

    if (socket !== undefined) {
      return socket;
    }

    throw error;
  }
};

/**
 * @typedef {{
 *   request?: (method: string, params: unknown) => Promise<unknown>,
 *   notification?: (message: RpcMessage) => void,
 *   threadParams?: object,
 *   turnParams?: object,
 *   threadStarted?: (response: unknown, config: EvalConfig) => Promise<void>,
 *   finished?: () => Promise<void>,
 * }} RunnerHooks Hooks consume heterogeneous server payloads and own their decoders.
 */
class RpcClient {
  /** @type {Error | undefined} */
  failure;
  nextId = 1;
  /** @type {Map<number | string, PromiseWithResolvers<unknown>>} */
  pending = new Map();
  /** @type {Map<string, RpcTurn>} */
  completedTurns = new Map();
  /** @type {Map<string, PromiseWithResolvers<RpcTurn>>} */
  turnWaiters = new Map();
  /** @type {TurnStart[]} */
  turnStarts = [];
  /** @type {Array<{ threadId: string, waiter: PromiseWithResolvers<RpcTurn> }>} */
  turnStartWaiters = [];

  /**
   * @param {WebSocket} socket Connected socket.
   * @param {Capture} capture Event collector.
   * @param {RunnerHooks} hooks Native service integration.
   */
  constructor(socket, capture, hooks = {}) {
    this.hooks = hooks;
    this.socket = socket;
    this.capture = capture;
    socket.addEventListener("message", ({ data }) => {
      try {
        this.#accept(rpcMessage(JSON.parse(String(data))));
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => {
      this.#fail(new Error("Codex app-server connection failed"));
    });
    socket.addEventListener("close", () => {
      this.#fail(new Error("Codex app-server connection closed"));
    });
  }

  /**
   * @param {string} method JSON-RPC method.
   * @param {unknown} params JSON-RPC parameters.
   * @returns {Promise<unknown>} JSON-RPC result.
   */
  request(method, params) {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    const id = this.nextId;
    this.nextId += 1;
    /** @type {PromiseWithResolvers<unknown>} */
    const response = Promise.withResolvers();
    this.pending.set(id, response);
    this.socket.send(JSON.stringify({ id, method, params }));

    return response.promise;
  }

  /**
   * @param {string} method JSON-RPC method.
   * @param {unknown} params JSON-RPC parameters.
   */
  notify(method, params = {}) {
    this.socket.send(JSON.stringify({ method, params }));
  }

  assertHealthy() {
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  /**
   * @param {string} turnId Turn id.
   * @returns {Promise<RpcTurn>} Completed turn.
   */
  waitForTurn(turnId) {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    const completed = this.completedTurns.get(turnId);

    if (completed !== undefined) {
      return Promise.resolve(completed);
    }

    /** @type {PromiseWithResolvers<RpcTurn>} */
    const waiter = Promise.withResolvers();
    this.turnWaiters.set(turnId, waiter);

    return waiter.promise;
  }

  /**
   * @param {string} threadId Expected thread id.
   * @returns {Promise<RpcTurn>} Next started turn.
   */
  waitForTurnStart(threadId) {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    const index = this.turnStarts.findIndex((entry) => entry.threadId === threadId);
    const started = this.turnStarts[index];

    if (started) {
      this.turnStarts.splice(index, 1);

      return Promise.resolve(started.turn);
    }

    /** @type {PromiseWithResolvers<RpcTurn>} */
    const waiter = Promise.withResolvers();
    this.turnStartWaiters.push({ threadId, waiter });

    return waiter.promise;
  }

  /** @param {Error} error Fatal transport or protocol error. */
  #fail(error) {
    if (this.failure !== undefined) {
      return;
    }

    this.failure = error;

    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    for (const { waiter } of this.turnStartWaiters) {
      waiter.reject(error);
    }

    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(error);
    }

    this.pending.clear();
    this.turnStartWaiters.length = 0;
    this.turnWaiters.clear();
  }

  /** @param {RpcMessage} message JSON-RPC message. */
  #accept(message) {
    if (message.id !== undefined && (message.hasResult || message.hasError)) {
      const pending = this.pending.get(message.id);

      if (pending === undefined) {
        return;
      }

      this.pending.delete(message.id);

      if (message.hasError) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }

      return;
    }

    if (message.id !== undefined && message.method !== undefined && this.hooks.request) {
      this.hooks.request(message.method, message.params).then(
        (result) => this.socket.send(JSON.stringify({ id: message.id, result })),
        (error) => {
          this.socket.send(
            JSON.stringify({ id: message.id, error: { code: -32603, message: String(error) } }),
          );
          this.#fail(error instanceof Error ? error : new Error(String(error)));
        },
      );

      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      this.socket.send(
        JSON.stringify({
          error: { code: -32_601, message: "unsupported server request" },
          id: message.id,
        }),
      );

      return;
    }

    this.hooks.notification?.(message);
    this.capture.accept(message);

    if (message.method === "turn/started") {
      const turn = message.params?.turn;

      if (turn === undefined) {
        throw new Error("turn/started omitted its turn");
      }

      const threadId = stringValue(message.params?.threadId, "started turn thread id");
      const index = this.turnStartWaiters.findIndex((entry) => entry.threadId === threadId);
      const waiting = this.turnStartWaiters[index];

      if (!waiting) {
        this.turnStarts.push({ threadId, turn });
      } else {
        this.turnStartWaiters.splice(index, 1);
        waiting.waiter.resolve(turn);
      }
    }

    if (message.method === "turn/completed") {
      const turn = message.params?.turn;

      if (turn === undefined) {
        throw new Error("turn/completed omitted its turn");
      }

      this.completedTurns.set(turn.id, turn);
      this.turnWaiters.get(turn.id)?.resolve(turn);
      this.turnWaiters.delete(turn.id);
    }
  }
}

/** @param {string} configPath @param {RunnerHooks} hooks */
export const run = async (configPath, hooks = {}) => {
  const config = evalConfig(JSON.parse(await readFile(configPath, "utf-8")));
  const codexHome = process.env["CODEX_HOME"];

  if (codexHome === undefined || codexHome.length === 0) {
    throw new Error("CODEX_HOME is required");
  }

  const statePath = `${codexHome}/eval-thread-id`;
  const eventsPath = `${codexHome}/eval-events.jsonl`;
  const instruction = await readFile(config.instructionPath, "utf-8");
  const socket = await connect();
  // Persist before turn completion, including when the supervisor kills us.
  appendFileSync(eventsPath, "", { mode: 0o600 });

  /** @param {UsageRecord | CompactionAttempt} record Journal and stream one runner event. */
  const publish = (record) => {
    appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
    process.stdout.write(`${JSON.stringify({ type: "eval_event", ...record })}\n`);
  };

  const capture = createCapture(publish);

  const rpc = new RpcClient(socket, capture, hooks);

  await rpc.request("initialize", {
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/commandExecution/outputDelta",
      ],
    },
    clientInfo: {
      name: "clanker_evals",
      title: "Clanker Evals",
      version: "1",
    },
  });
  rpc.notify("initialized");

  let threadId;

  try {
    const savedThreadId = await readFile(statePath, "utf-8");
    threadId = savedThreadId.trim();
    await rpc.request("thread/resume", { threadId });
  } catch (error) {
    if (threadId !== undefined && threadId.length > 0) {
      throw error;
    }

    const result = await rpc.request("thread/start", {
      approvalPolicy: "never",
      cwd: "/app",
      experimentalRawEvents: true,
      model: config.model,
      sandbox: "danger-full-access",
      ...hooks.threadParams,
    });

    await hooks.threadStarted?.(result, config);
    threadId = startedThreadId(result);
    await writeFile(statePath, `${threadId}\n`);
  }

  if (config.compactBefore) {
    await rpc.request("thread/compact/start", { threadId });
    const compactionTurn = await rpc.waitForTurnStart(threadId);
    capture.beginCompaction(compactionTurn.id);
    await rpc.waitForTurn(compactionTurn.id);
  }

  const turnResult = await rpc.request("turn/start", {
    approvalPolicy: "never",
    cwd: "/app",
    effort: config.effort,
    input: [{ text: instruction, text_elements: [], type: "text" }],
    model: config.model,
    summary: config.summary,
    threadId,
    ...hooks.turnParams,
  });

  const turnId = startedTurnId(turnResult);
  const completed = await rpc.waitForTurn(turnId);

  if (completed.status !== "completed") {
    throw new Error(`Codex turn ended with status ${completed.status}`);
  }

  rpc.assertHealthy();
  const captured = capture.finish();

  for (const attempt of captured.attempts) {
    publish({
      compactedAfterSegment: config.compactedAfterSegment,
      kind: "compaction_attempt",
      state: attempt.state,
      threadId,
      timestamp: attempt.timestamp,
      turnId: attempt.turnId,
    });
  }

  await hooks.finished?.();
  socket.close();
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const configPath = process.argv[2];

  // The image build runs this without arguments: the usage error proves the entry point and its
  // deployed dependencies load.
  if (process.argv.length !== 3 || configPath === undefined) {
    throw new Error("usage: codex-eval CONFIG_JSON");
  }

  await run(configPath);
}
