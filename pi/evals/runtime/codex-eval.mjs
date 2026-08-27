#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const SERVER_URL = "ws://127.0.0.1:41973";
const SERVER_WAIT_MS = 10_000;

/**
 * @typedef {{
 *   compactBefore: boolean,
 *   compactedAfterSegment: number,
 *   effort: string | null,
 *   instructionPath: string,
 *   model: string,
 *   summary: string | null,
 * }} EvalConfig
 * @typedef {{ id?: string, type?: string }} RpcItem
 * @typedef {{ id: string, status: string }} RpcTurn
 * @typedef {{ threadId: string, turn: RpcTurn }} TurnStart
 * @typedef {{
 *   item?: RpcItem,
 *   responseId?: string,
 *   threadId?: string,
 *   turn?: RpcTurn,
 *   turnId?: string,
 *   usage?: unknown,
 * }} RpcParams
 * @typedef {{
 *   error?: unknown,
 *   hasError: boolean,
 *   hasResult: boolean,
 *   id?: number | string,
 *   method?: string,
 *   params?: RpcParams,
 *   result?: unknown,
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
 * @param {string} text JSON text.
 * @returns {unknown} Parsed value.
 */
const parseJson = (text) => {
  return /** @type {unknown} */ (JSON.parse(text));
};

/**
 * @param {unknown} value Value to test.
 * @returns {value is object} Whether the value is a non-null object.
 */
const isObject = (value) => value !== null && !Array.isArray(value) && value === Object(value);

/**
 * @param {unknown} value Value to test.
 * @returns {value is number} Whether the value is a number.
 */
const isNumber = (value) => value === Number(value);

/**
 * @param {unknown} value Value to test.
 * @returns {value is string} Whether the value is a string.
 */
const isString = (value) => value === String(value);

/**
 * @param {unknown} value Value to validate.
 * @param {string} source Human-readable source.
 * @returns {object} Validated object.
 */
const objectValue = (value, source) => {
  if (!isObject(value)) {
    throw new TypeError(`${source} must be an object`);
  }
  return value;
};

/**
 * @param {unknown} value Value to validate.
 * @param {string} source Human-readable source.
 * @returns {string} Validated string.
 */
const stringValue = (value, source) => {
  if (!isString(value) || value.length === 0) {
    throw new TypeError(`${source} must be a non-empty string`);
  }
  return value;
};

/**
 * @param {unknown} value Value to validate.
 * @param {string} source Human-readable source.
 * @returns {string | undefined} Validated optional string.
 */
const optionalString = (value, source) =>
  value === undefined ? undefined : stringValue(value, source);

/**
 * @param {unknown} value Parsed JSON.
 * @returns {EvalConfig} Validated runner config.
 */
const evalConfig = (value) => {
  const config = objectValue(value, "Codex eval config");
  const compactBefore = "compactBefore" in config ? config.compactBefore : false;
  const compactedAfterSegment =
    "compactedAfterSegment" in config ? config.compactedAfterSegment : -1;
  const effort = "effort" in config ? config.effort : null;
  const summary = "summary" in config ? config.summary : null;
  if (compactBefore !== true && compactBefore !== false) {
    throw new TypeError("compactBefore must be a boolean");
  }
  if (!Number.isInteger(compactedAfterSegment) || compactedAfterSegment < -1) {
    throw new TypeError("compactedAfterSegment must be an integer greater than or equal to -1");
  }
  if (effort !== null && !isString(effort)) {
    throw new TypeError("effort must be a string or null");
  }
  if (summary !== null && !isString(summary)) {
    throw new TypeError("summary must be a string or null");
  }
  return {
    compactBefore,
    compactedAfterSegment,
    effort,
    instructionPath: stringValue(
      "instructionPath" in config ? config.instructionPath : undefined,
      "instructionPath",
    ),
    model: stringValue("model" in config ? config.model : undefined, "model"),
    summary,
  };
};

/**
 * @param {unknown} value Parsed JSON.
 * @returns {RpcMessage} Validated JSON-RPC message.
 */
const rpcMessage = (value) => {
  const message = objectValue(value, "JSON-RPC message");
  const id = "id" in message ? message.id : undefined;
  if (id !== undefined && !isNumber(id) && !isString(id)) {
    throw new TypeError("JSON-RPC id must be a number or string");
  }

  let params;
  if ("params" in message && message.params !== undefined) {
    const rawParams = objectValue(message.params, "JSON-RPC params");
    let item;
    if ("item" in rawParams && rawParams.item !== undefined) {
      const rawItem = objectValue(rawParams.item, "JSON-RPC item");
      item = {
        id: optionalString("id" in rawItem ? rawItem.id : undefined, "item.id"),
        type: optionalString("type" in rawItem ? rawItem.type : undefined, "item.type"),
      };
    }
    let turn;
    if ("turn" in rawParams && rawParams.turn !== undefined) {
      const rawTurn = objectValue(rawParams.turn, "JSON-RPC turn");
      turn = {
        id: stringValue("id" in rawTurn ? rawTurn.id : undefined, "turn.id"),
        status: stringValue("status" in rawTurn ? rawTurn.status : undefined, "turn.status"),
      };
    }
    params = {
      item,
      responseId: optionalString(
        "responseId" in rawParams ? rawParams.responseId : undefined,
        "params.responseId",
      ),
      threadId: optionalString(
        "threadId" in rawParams ? rawParams.threadId : undefined,
        "params.threadId",
      ),
      turn,
      turnId: optionalString("turnId" in rawParams ? rawParams.turnId : undefined, "params.turnId"),
      usage: "usage" in rawParams ? rawParams.usage : undefined,
    };
  }

  return {
    error: "error" in message ? message.error : undefined,
    hasError: "error" in message,
    hasResult: "result" in message,
    id,
    method: optionalString("method" in message ? message.method : undefined, "JSON-RPC method"),
    params,
    result: "result" in message ? message.result : undefined,
  };
};

/**
 * @param {unknown} result thread/start result.
 * @returns {string} Started thread id.
 */
const startedThreadId = (result) => {
  const response = objectValue(result, "thread/start result");
  const thread = objectValue(
    "thread" in response ? response.thread : undefined,
    "thread/start result.thread",
  );
  return stringValue("id" in thread ? thread.id : undefined, "thread/start result.thread.id");
};

/**
 * @param {unknown} result turn/start result.
 * @returns {string} Started turn id.
 */
const startedTurnId = (result) => {
  const response = objectValue(result, "turn/start result");
  const turn = objectValue(
    "turn" in response ? response.turn : undefined,
    "turn/start result.turn",
  );
  return stringValue("id" in turn ? turn.id : undefined, "turn/start result.turn.id");
};

const createCapture = () => {
  /** @type {Map<string, { completed: boolean, expected: boolean, itemId?: string, state?: CompactionAttempt["state"], timestamp?: string }>} */
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
    if (compaction.state !== undefined) {
      throw new Error(`duplicate terminal state for Codex compaction turn ${turnId}`);
    }
    if (!["completed", "failed", "interrupted"].includes(turn.status)) {
      throw new Error(`unknown Codex compaction status: ${turn.status}`);
    }
    if (compaction.completed) {
      compaction.state = "succeeded";
    } else if (turn.status === "failed") {
      compaction.state = "failed";
    } else if (turn.status === "interrupted") {
      compaction.state = "aborted";
    } else {
      throw new Error(`completed Codex compaction turn ${turnId} omitted item/completed`);
    }
    compaction.timestamp = new Date().toISOString();
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
    if (terminal !== undefined && compaction.state === undefined) {
      settle(turnId, terminal);
    }
  };

  /** @param {RpcMessage} message JSON-RPC message. */
  const accept = (message) => {
    const { method, params } = message;
    if (method === "item/started" && params?.item?.type === "contextCompaction") {
      const turnId = stringValue(params.turnId, "compaction turn id");
      const compaction = compactions.get(turnId) ?? { completed: false, expected: false };
      if (compaction.itemId !== undefined || compaction.state !== undefined) {
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
        compaction.state !== undefined
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
    records.push({
      kind,
      responseId,
      threadId,
      turnId,
      usage: params.usage,
    });
  };

  const finish = () => {
    if ([...compactions.values()].some((compaction) => compaction.state === undefined)) {
      throw new Error("Codex turn ended without a terminal compaction state");
    }
    if (!records.some((record) => record.kind === "ordinary")) {
      throw new Error("Codex turn completed without an ordinary model response");
    }
    return {
      attempts: [...compactions.entries()].map(([turnId, compaction]) => ({
        state: compaction.state,
        timestamp: compaction.timestamp,
        turnId,
      })),
      records,
    };
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
  if (Date.now() >= deadline) {
    return undefined;
  }
  await delay(100);
  try {
    return await openSocket();
  } catch {
    return waitForSocket(deadline);
  }
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
   */
  constructor(socket, capture) {
    this.socket = socket;
    this.capture = capture;
    socket.addEventListener("message", ({ data }) => {
      try {
        this.#accept(rpcMessage(parseJson(String(data))));
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
    const index = this.turnStarts.findIndex((started) => started.threadId === threadId);
    if (index >= 0) {
      return Promise.resolve(this.turnStarts.splice(index, 1)[0].turn);
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
    if (message.id !== undefined && message.method !== undefined) {
      this.socket.send(
        JSON.stringify({
          error: { code: -32_601, message: "unsupported server request" },
          id: message.id,
        }),
      );
      return;
    }
    this.capture.accept(message);
    if (message.method === "turn/started") {
      const turn = message.params?.turn;
      if (turn === undefined) {
        throw new Error("turn/started omitted its turn");
      }
      const threadId = stringValue(message.params?.threadId, "started turn thread id");
      const index = this.turnStartWaiters.findIndex((entry) => entry.threadId === threadId);
      if (index < 0) {
        this.turnStarts.push({ threadId, turn });
      } else {
        this.turnStartWaiters.splice(index, 1)[0].waiter.resolve(turn);
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

const run = async (configPath) => {
  const config = evalConfig(parseJson(await readFile(configPath, "utf-8")));
  const codexHome = process.env.CODEX_HOME;
  if (codexHome === undefined || codexHome.length === 0) {
    throw new Error("CODEX_HOME is required");
  }
  const statePath = `${codexHome}/eval-thread-id`;
  const eventsPath = `${codexHome}/eval-events.jsonl`;
  const instruction = await readFile(config.instructionPath, "utf-8");
  const socket = await connect();
  const capture = createCapture();
  const rpc = new RpcClient(socket, capture);

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
    });
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
  });
  const turnId = startedTurnId(turnResult);
  const completed = await rpc.waitForTurn(turnId);
  if (completed.status !== "completed") {
    throw new Error(`Codex turn ended with status ${completed.status}`);
  }

  rpc.assertHealthy();
  const captured = capture.finish();
  const records = [
    ...captured.attempts.map((attempt) => ({
      compactedAfterSegment: config.compactedAfterSegment,
      kind: "compaction_attempt",
      state: attempt.state,
      threadId,
      timestamp: attempt.timestamp,
      turnId: attempt.turnId,
    })),
    ...captured.records,
  ];
  await appendFile(eventsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  for (const record of records) {
    process.stdout.write(`${JSON.stringify({ type: "eval_event", ...record })}\n`);
  }
  socket.close();
};

const selfTest = () => {
  const capture = createCapture();
  /**
   * @param {string} method
   * @param {RpcParams} params
   */
  const accept = (method, params) =>
    capture.accept({ hasError: false, hasResult: false, method, params });
  accept("rawResponse/completed", {
    responseId: "a",
    threadId: "t",
    turnId: "ordinary",
    usage: {},
  });
  capture.beginCompaction("succeeded");
  accept("item/started", {
    item: { id: "c1", type: "contextCompaction" },
    turnId: "succeeded",
  });
  accept("rawResponse/completed", {
    responseId: "b",
    threadId: "t",
    turnId: "succeeded",
    usage: {},
  });
  accept("item/completed", {
    item: { id: "c1", type: "contextCompaction" },
    turnId: "succeeded",
  });
  accept("rawResponse/completed", {
    responseId: "c",
    threadId: "t",
    turnId: "succeeded",
    usage: {},
  });
  accept("turn/completed", {
    turn: { id: "succeeded", status: "completed" },
  });
  capture.beginCompaction("failed");
  accept("item/started", {
    item: { id: "c2", type: "contextCompaction" },
    turnId: "failed",
  });
  accept("rawResponse/completed", {
    responseId: "d",
    threadId: "t",
    turnId: "failed",
    usage: null,
  });
  accept("turn/completed", {
    turn: { id: "failed", status: "failed" },
  });
  capture.beginCompaction("aborted");
  accept("item/started", {
    item: { id: "c3", type: "contextCompaction" },
    turnId: "aborted",
  });
  accept("turn/completed", {
    turn: { id: "aborted", status: "interrupted" },
  });
  accept("turn/completed", {
    turn: { id: "pre-hook", status: "interrupted" },
  });
  capture.beginCompaction("pre-hook");
  capture.beginCompaction("post-hook");
  accept("item/started", {
    item: { id: "c4", type: "contextCompaction" },
    turnId: "post-hook",
  });
  accept("rawResponse/completed", {
    responseId: "e",
    threadId: "t",
    turnId: "post-hook",
    usage: {},
  });
  accept("item/completed", {
    item: { id: "c4", type: "contextCompaction" },
    turnId: "post-hook",
  });
  accept("turn/completed", {
    turn: { id: "post-hook", status: "interrupted" },
  });
  const captured = capture.finish();
  const kinds = captured.records.map(({ kind }) => kind).join(",");
  if (kinds !== "ordinary,compaction,ordinary,compaction") {
    throw new Error(`bad capture: ${kinds}`);
  }
  const states = captured.attempts.map(({ state }) => state).join(",");
  if (states !== "succeeded,failed,aborted,aborted,succeeded") {
    throw new Error(`bad compaction states: ${states}`);
  }

  const malformed = createCapture();
  malformed.beginCompaction("malformed");
  try {
    malformed.accept({
      hasError: false,
      hasResult: false,
      method: "turn/completed",
      params: { turn: { id: "malformed", status: "completed" } },
    });
  } catch {
    return;
  }
  throw new Error("accepted a completed compaction turn without an item completion");
};

if (process.argv[2] === "--self-test") {
  selfTest();
} else if (process.argv.length === 3) {
  await run(process.argv[2]);
} else {
  throw new Error("usage: codex-eval CONFIG_JSON | codex-eval --self-test");
}
