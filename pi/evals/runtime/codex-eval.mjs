#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const SERVER_URL = "ws://127.0.0.1:41973";
const SERVER_WAIT_MS = 10_000;

/**
 * @typedef {{
 *   compactBefore: boolean,
 *   effort: string | null,
 *   instructionPath: string,
 *   model: string,
 *   summary: string | null,
 * }} EvalConfig
 * @typedef {{ id?: string, type?: string }} RpcItem
 * @typedef {{ id: string, status: string }} RpcTurn
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
 */

/**
 * @param {string} text JSON text.
 * @returns {unknown} Parsed value.
 */
const parseJson = (text) => {
  /** @type {unknown} */
  const value = JSON.parse(text);
  return value;
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
  const effort = "effort" in config ? config.effort : null;
  const summary = "summary" in config ? config.summary : null;
  if (compactBefore !== true && compactBefore !== false) {
    throw new TypeError("compactBefore must be a boolean");
  }
  if (effort !== null && !isString(effort)) {
    throw new TypeError("effort must be a string or null");
  }
  if (summary !== null && !isString(summary)) {
    throw new TypeError("summary must be a string or null");
  }
  return {
    compactBefore,
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

const createUsageCapture = () => {
  /** @type {Map<string, string>} */
  const activeCompactions = new Map();
  /** @type {UsageRecord[]} */
  const records = [];
  const responseIds = new Set();

  /** @param {RpcMessage} message JSON-RPC message. */
  const accept = (message) => {
    const { method, params } = message;
    if (method === "item/started" && params?.item?.type === "contextCompaction") {
      activeCompactions.set(
        stringValue(params.item.id, "compaction item id"),
        stringValue(params.turnId, "compaction turn id"),
      );
      return;
    }
    if (method === "item/completed" && params?.item?.type === "contextCompaction") {
      activeCompactions.delete(stringValue(params.item.id, "compaction item id"));
      return;
    }
    if (method !== "rawResponse/completed") {
      return;
    }
    const responseId = stringValue(params?.responseId, "response id");
    const threadId = stringValue(params?.threadId, "response thread id");
    const turnId = stringValue(params?.turnId, "response turn id");
    if (params?.usage === undefined || params.usage === null) {
      throw new Error("Codex response omitted exact usage");
    }
    if (responseIds.has(responseId)) {
      throw new Error(`duplicate Codex response id: ${responseId}`);
    }
    const compactions = [...activeCompactions.values()].filter(
      (activeTurnId) => activeTurnId === turnId,
    );
    if (compactions.length > 1) {
      throw new Error("ambiguous overlapping Codex compactions");
    }
    responseIds.add(responseId);
    records.push({
      kind: compactions.length === 1 ? "compaction" : "ordinary",
      responseId,
      threadId,
      turnId,
      usage: params.usage,
    });
  };

  const finish = () => {
    if (activeCompactions.size !== 0) {
      throw new Error("Codex turn ended during compaction");
    }
    if (!records.some((record) => record.kind === "ordinary")) {
      throw new Error("Codex turn completed without an ordinary model response");
    }
    return records;
  };

  return { accept, finish };
};

/** @typedef {ReturnType<typeof createUsageCapture>} UsageCapture */

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

/** @returns {Promise<void>} */
const retryDelay = () => {
  /** @type {PromiseWithResolvers<void>} */
  const wait = Promise.withResolvers();
  setTimeout(() => {
    wait.resolve();
  }, 100);
  return wait.promise;
};

/**
 * @param {number} deadline Retry deadline.
 * @returns {Promise<WebSocket | undefined>} Connected socket, if ready.
 */
const waitForSocket = async (deadline) => {
  if (Date.now() >= deadline) {
    return undefined;
  }
  await retryDelay();
  try {
    return await openSocket();
  } catch {
    return waitForSocket(deadline);
  }
};

const connect = async (statePath) => {
  try {
    return await openSocket();
  } catch (error) {
    try {
      await readFile(statePath, "utf-8");
    } catch {
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
    }
    throw error;
  }
};

class RpcClient {
  /** @type {Array<(turnId: string) => void>} */
  compactionStartWaiters = [];
  nextId = 1;
  /** @type {Map<number | string, PromiseWithResolvers<unknown>>} */
  pending = new Map();
  /** @type {Map<string, RpcTurn>} */
  completedTurns = new Map();
  /** @type {Map<string, (turn: RpcTurn) => void>} */
  turnWaiters = new Map();

  /**
   * @param {WebSocket} socket Connected socket.
   * @param {UsageCapture} capture Usage collector.
   */
  constructor(socket, capture) {
    this.socket = socket;
    this.capture = capture;
    socket.addEventListener("message", ({ data }) => {
      this.#accept(rpcMessage(parseJson(String(data))));
    });
  }

  /**
   * @param {string} method JSON-RPC method.
   * @param {unknown} params JSON-RPC parameters.
   * @returns {Promise<unknown>} JSON-RPC result.
   */
  request(method, params) {
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

  /**
   * @param {string} turnId Turn id.
   * @returns {Promise<RpcTurn>} Completed turn.
   */
  waitForTurn(turnId) {
    const completed = this.completedTurns.get(turnId);
    if (completed !== undefined) {
      return Promise.resolve(completed);
    }
    /** @type {PromiseWithResolvers<RpcTurn>} */
    const waiter = Promise.withResolvers();
    this.turnWaiters.set(turnId, waiter.resolve);
    return waiter.promise;
  }

  /** @returns {Promise<string>} Started compaction turn id. */
  waitForCompactionStart() {
    /** @type {PromiseWithResolvers<string>} */
    const waiter = Promise.withResolvers();
    this.compactionStartWaiters.push(waiter.resolve);
    return waiter.promise;
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
    if (message.method === "item/started" && message.params?.item?.type === "contextCompaction") {
      const turnId = stringValue(message.params.turnId, "compaction turn id");
      this.compactionStartWaiters.shift()?.(turnId);
    }
    if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      if (turn === undefined) {
        throw new Error("turn/completed omitted its turn");
      }
      this.completedTurns.set(turn.id, turn);
      this.turnWaiters.get(turn.id)?.(turn);
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
  const usagePath = `${codexHome}/eval-usage.jsonl`;
  const instruction = await readFile(config.instructionPath, "utf-8");
  const socket = await connect(statePath);
  const capture = createUsageCapture();
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
    const started = rpc.waitForCompactionStart();
    await rpc.request("thread/compact/start", { threadId });
    const turnId = await started;
    const completed = await rpc.waitForTurn(turnId);
    if (completed.status !== "completed") {
      throw new Error(`Codex compaction ended with status ${completed.status}`);
    }
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

  const records = capture.finish();
  await appendFile(usagePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  for (const record of records) {
    process.stdout.write(`${JSON.stringify({ type: "eval_usage", ...record })}\n`);
  }
  socket.close();
};

const selfTest = () => {
  const capture = createUsageCapture();
  capture.accept({
    hasError: false,
    hasResult: false,
    method: "rawResponse/completed",
    params: { responseId: "a", threadId: "t", turnId: "1", usage: {} },
  });
  capture.accept({
    hasError: false,
    hasResult: false,
    method: "item/started",
    params: { item: { id: "c", type: "contextCompaction" }, turnId: "1" },
  });
  capture.accept({
    hasError: false,
    hasResult: false,
    method: "rawResponse/completed",
    params: { responseId: "b", threadId: "t", turnId: "1", usage: {} },
  });
  capture.accept({
    hasError: false,
    hasResult: false,
    method: "item/completed",
    params: { item: { id: "c", type: "contextCompaction" }, turnId: "1" },
  });
  const kinds = capture
    .finish()
    .map(({ kind }) => kind)
    .join(",");
  if (kinds !== "ordinary,compaction") {
    throw new Error(`bad capture: ${kinds}`);
  }
};

if (process.argv[2] === "--self-test") {
  selfTest();
} else if (process.argv.length === 3) {
  await run(process.argv[2]);
} else {
  throw new Error("usage: codex-eval CONFIG_JSON | codex-eval --self-test");
}
